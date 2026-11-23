// Snapshot / history / error-log persistence under <git-dir>/offscreen/.
import fs from 'node:fs';
import path from 'node:path';

export const SNAPSHOT_VERSION = 1;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const HISTORY_KEEP = 50;
const HISTORY_MAX_BYTES = 256 * 1024;
const ERRORLOG_MAX_BYTES = 128 * 1024;

export function storeDir(gitDir) {
  return path.join(gitDir, 'offscreen');
}

function sessionFile(gitDir, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
  return path.join(storeDir(gitDir), 'sessions', `${safe}.json`);
}

function latestFile(gitDir) {
  return path.join(storeDir(gitDir), 'snapshot.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write via tmp file + rename so readers never see a half-written file. */
export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows: rename over a file another process has open can fail transiently.
      if (i >= 4) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
      sleepMs(15 * (i + 1));
    }
  }
}

function valid(snap) {
  return snap && snap.version === SNAPSHOT_VERSION && typeof snap.savedAt === 'number' && snap.trackers && typeof snap.trackers === 'object';
}

/**
 * Baseline to compare against: this session's own snapshot if it has one,
 * otherwise the latest snapshot written by any session (so a brand-new chat
 * still learns what changed since the previous one).
 */
export function loadSnapshot(gitDir, sessionId) {
  if (sessionId) {
    const s = readJson(sessionFile(gitDir, sessionId));
    if (valid(s)) return s;
  }
  const l = readJson(latestFile(gitDir));
  return valid(l) ? l : null;
}

export function hasSessionSnapshot(gitDir, sessionId) {
  return valid(readJson(sessionFile(gitDir, sessionId)));
}

/**
 * Save unless a snapshot taken *later* is already there. PostToolUse saves run in the
 * background, so an older save can finish after a newer one; it must not win.
 */
export function saveSnapshot(gitDir, sessionId, snap) {
  const put = (file) => {
    const existing = readJson(file);
    if (existing && typeof existing.takenAtMs === 'number' && typeof snap.takenAtMs === 'number' && existing.takenAtMs > snap.takenAtMs) return;
    writeJsonAtomic(file, snap);
  };
  if (sessionId) put(sessionFile(gitDir, sessionId));
  put(latestFile(gitDir));
  if (sessionId) pruneSessions(gitDir);
}

/** Drop the per-session baselines and keep only `snap` as the shared one. */
export function resetSnapshots(gitDir, snap) {
  fs.rmSync(path.join(storeDir(gitDir), 'sessions'), { recursive: true, force: true });
  writeJsonAtomic(latestFile(gitDir), snap);
}

function pruneSessions(gitDir) {
  const dir = path.join(storeDir(gitDir), 'sessions');
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f);
    } catch {}
  }
}

export function appendHistory(gitDir, entry) {
  const file = path.join(storeDir(gitDir), 'history.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  try {
    if (fs.statSync(file).size > HISTORY_MAX_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(file, lines.slice(-HISTORY_KEEP).join('\n') + '\n');
    }
  } catch {}
}

export function readHistory(gitDir, n) {
  try {
    const lines = fs.readFileSync(path.join(storeDir(gitDir), 'history.jsonl'), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch {
    return [];
  }
}

export function logError(gitDir, err) {
  if (!gitDir) return;
  try {
    const file = path.join(storeDir(gitDir), 'error.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > ERRORLOG_MAX_BYTES) fs.writeFileSync(file, '');
    } catch {}
    const msg = err && err.stack ? err.stack : String(err);
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}
