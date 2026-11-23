// "Active" repositories for large workspaces: the ones the AI actually read or changed.
//
// When a session folder holds more repositories than workspace.maxRepos, watching all of
// them is too slow. Instead every tool call reports which repositories it touched (from the
// paths in its input), and only repositories touched recently are watched.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from './store.mjs';

const WIN = process.platform === 'win32';
const KEEP_MS = 30 * 24 * 3600 * 1000;
const MAX_STRINGS = 64;
const MAX_TEXT = 64 * 1024;
const MAX_TOKENS = 200;

const norm = (p) => (WIN ? p.toLowerCase() : p);

/** Is `p` inside `root` (not equal to it)? Both absolute. */
function inside(root, p) {
  const rel = path.relative(norm(root), norm(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Git Bash style /c/Users/... -> C:\Users\... on Windows. */
function fromPosixDrive(p) {
  if (WIN && /^\/[a-zA-Z](\/|$)/.test(p)) return `${p[1].toUpperCase()}:\\${p.slice(3).replace(/\//g, '\\')}`;
  return p;
}

function collectStrings(v, out, budget = { n: 0, chars: 0 }) {
  if (budget.n >= MAX_STRINGS || budget.chars >= MAX_TEXT) return out;
  if (typeof v === 'string') {
    const s = v.slice(0, MAX_TEXT - budget.chars);
    budget.n++;
    budget.chars += s.length;
    out.push(s);
  } else if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out, budget);
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v)) collectStrings(x, out, budget);
  }
  return out;
}

/** Path-like candidates from one string of tool input. `strict` = only keep ones that exist. */
function candidates(str) {
  const out = [];
  // apply_patch (Codex) headers
  for (const m of str.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    out.push({ p: (m[1] || m[2]).trim(), strict: false });
  }
  // A whole single-line value is often a path (file_path, path, notebook_path, cwd).
  if (!str.includes('\n') && str.length < 1024) out.push({ p: str.trim(), strict: !/[\\/]/.test(str) });
  // Tokens from commands and free text.
  const toks = str.split(/[\s"'`;&|()<>=,]+/).filter((t) => t && t.length < 512).slice(0, MAX_TOKENS);
  for (const t of toks) {
    if (t.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) continue; // flags, URLs
    out.push({ p: t, strict: !/[\\/]/.test(t) });
  }
  return out;
}

/** Nearest directory at or above `p` (inside root) that contains `.git`, or null. */
function repoAbove(root, p, cache) {
  let d = p;
  const seen = [];
  while (inside(root, d)) {
    const key = norm(d);
    if (cache.has(key)) {
      const hit = cache.get(key);
      for (const s of seen) cache.set(s, hit);
      return hit;
    }
    seen.push(key);
    if (fs.existsSync(path.join(d, '.git'))) {
      for (const s of seen) cache.set(s, d);
      return d;
    }
    d = path.dirname(d);
  }
  for (const s of seen) cache.set(s, null);
  return null;
}

/**
 * Repository tops (absolute) under `root` that a hook input refers to:
 * the hook's cwd plus any path found in tool_input.
 */
export function touchedRepos(input, root) {
  const cwd = input.cwd ? path.resolve(fromPosixDrive(input.cwd)) : root;
  const cache = new Map();
  const found = new Map();
  const add = (abs) => {
    const top = repoAbove(root, abs, cache);
    if (top) found.set(norm(top), top);
  };
  add(cwd);
  for (const s of collectStrings(input.tool_input ?? {}, [])) {
    for (const { p, strict } of candidates(s)) {
      if (!p) continue;
      const abs = path.resolve(cwd, fromPosixDrive(p));
      if (strict && !fs.existsSync(abs)) continue;
      add(abs);
    }
  }
  return [...found.values()];
}

// ------------------------------------------------------------- recent list

function stateFile(root, home) {
  const id = crypto.createHash('sha1').update(norm(path.resolve(root))).digest('hex').slice(0, 16);
  return path.join(home, '.offscreen', 'workspaces', `${id}.json`);
}

function relKey(root, top) {
  return path.relative(root, top).split(path.sep).join('/');
}

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && typeof s.repos === 'object') return s;
  } catch {}
  return { repos: {} };
}

/** Record that `tops` were used now. Returns nothing; never throws. */
export function markActive(root, tops, home = process.env.OFFSCREEN_HOME || os.homedir()) {
  if (!tops.length) return;
  try {
    const file = stateFile(root, home);
    const state = readState(file);
    const now = Date.now();
    state.root = root;
    for (const t of tops) state.repos[relKey(root, t)] = now;
    for (const [k, at] of Object.entries(state.repos)) if (now - at > KEEP_MS) delete state.repos[k];
    writeJsonAtomic(file, state);
  } catch {}
}

/** Repository tops used within `recentDays`, most recent first, at most `max`. */
export function recentRepos(root, { recentDays, maxRepos }, home = process.env.OFFSCREEN_HOME || os.homedir()) {
  const state = readState(stateFile(root, home));
  const since = Date.now() - recentDays * 24 * 3600 * 1000;
  return Object.entries(state.repos)
    .filter(([, at]) => at >= since)
    .sort((a, b) => b[1] - a[1])
    .map(([rel]) => path.resolve(root, rel))
    .filter((top) => fs.existsSync(path.join(top, '.git')))
    .slice(0, maxRepos);
}
