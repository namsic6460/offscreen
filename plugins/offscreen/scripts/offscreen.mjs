#!/usr/bin/env node
// offscreen entry point: save | diff | show | reset
//
//   save  (hook: PostToolUse, Stop)  - record the current state as this session's baseline
//   diff  (hook: UserPromptSubmit)   - report what changed since the baseline, then save
//   show  (manual)                   - preview pending changes + recently reported history
//   reset (manual)                   - make the current state the baseline for every session
//
// The watched root is the session folder. If it is inside a git repository, that repository
// is watched; otherwise every repository found below it (workspace mode).
//
// Hooks must never block the user: every path exits 0, errors go to <git-dir>/offscreen/error.log.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { makeT, render, summarize } from './lib/format.mjs';
import { SNAPSHOT_VERSION, appendHistory, loadSnapshot, logError, readHistory, resetSnapshots, saveSnapshot } from './lib/store.mjs';
import { pool, resolveRepos } from './lib/workspace.mjs';
import gitTracker from './trackers/git.mjs';

const TRACKERS = { git: gitTracker };
const MODES = ['save', 'diff', 'show', 'reset'];
const CONCURRENCY = 8;

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // A host that never closes stdin must not keep this process alive past the hook timeout.
      process.stdin.destroy();
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
      // Hosts may keep stdin open after writing the event; go as soon as it is complete JSON.
      try {
        JSON.parse(data);
        finish();
      } catch {}
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function out(text) {
  fs.writeSync(1, text.endsWith('\n') ? text : `${text}\n`);
}

async function takeSnapshot(ctx) {
  const takenAtMs = Date.now(); // before reading any state
  const trackers = {};
  for (const name of ctx.config.trackers) {
    const tr = TRACKERS[name];
    if (!tr) continue;
    const s = await tr.snapshot(ctx); // throws on git failure/timeout -> caller skips this repo
    if (s != null) trackers[name] = s;
  }
  return { version: SNAPSHOT_VERSION, savedAt: Math.floor(takenAtMs / 1000), takenAtMs, trackers };
}

async function diffSnapshots(prev, cur, ctx) {
  const sections = [];
  for (const name of ctx.config.trackers) {
    const tr = TRACKERS[name];
    if (!tr || !prev.trackers[name] || !cur.trackers[name]) continue;
    sections.push(...(await tr.diff(prev.trackers[name], cur.trackers[name], { ...ctx, prevSavedAt: prev.savedAt })));
  }
  return sections;
}

function fmtTime(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Per-repository work for one mode. Returns { label, sections?, history? } or null. */
async function runRepo(mode, repo, env) {
  const { root, workspace, sessionId, outT } = env;
  const config = loadConfig(workspace ? [root, repo.top] : [repo.top]);
  if (!config.enabled) return null;
  const label = workspace ? path.relative(root, repo.top).split(path.sep).join('/') : null;
  // git commands run from the repository top, whatever the session folder is.
  const ctx = { cwd: repo.top, top: repo.top, gitDir: repo.gitDir, config, t: outT };
  try {
    if (mode === 'save') {
      saveSnapshot(repo.gitDir, sessionId, await takeSnapshot(ctx));
      return null;
    }
    if (mode === 'reset') {
      resetSnapshots(repo.gitDir, await takeSnapshot(ctx));
      return { label };
    }
    if (mode === 'show') {
      const prev = loadSnapshot(repo.gitDir, null);
      const sections = prev ? await diffSnapshots(prev, await takeSnapshot(ctx), ctx) : [];
      return { label, sections, noBaseline: !prev, history: readHistory(repo.gitDir, 5) };
    }
    // diff
    const prev = loadSnapshot(repo.gitDir, sessionId);
    const cur = await takeSnapshot(ctx);
    const sections = prev ? await diffSnapshots(prev, cur, ctx) : []; // first run / corrupt snapshot: just save
    saveSnapshot(repo.gitDir, sessionId, cur); // so the same change is never reported twice
    if (sections.length) {
      try {
        const text = render([{ label: null, sections }], config.limits, outT);
        appendHistory(repo.gitDir, { at: cur.savedAt, session: sessionId, event: env.event, text });
      } catch (e) {
        logError(repo.gitDir, e);
      }
    }
    return { label, sections };
  } catch (e) {
    logError(repo.gitDir, e);
    return { label, error: e.message };
  }
}

async function main() {
  const args = process.argv.slice(1);
  const mode = args.find((a) => MODES.includes(a));
  if (!mode) {
    process.stderr.write(`usage: offscreen.mjs <${MODES.join('|')}> [--cwd DIR]\n`);
    return;
  }
  const isHook = mode === 'save' || mode === 'diff';
  const input = isHook ? await readStdin() : {};
  // Prefer the session's project folder: Claude Code's `cwd` follows `cd` in Bash.
  const root = path.resolve(argValue(args, '--cwd') || process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());

  const rootCfg = loadConfig([root]);
  const { workspace, repos } = await resolveRepos(root, rootCfg.workspace);
  if (!repos.length) {
    if (!isHook) out(makeT(rootCfg.language)('notRepo', { cwd: root }));
    return;
  }
  // Output-wide settings (language, notify, maxChars): the repo's own config, or the workspace's.
  const outCfg = workspace ? rootCfg : loadConfig([repos[0].top]);
  const t = makeT(outCfg.language);
  if (!outCfg.enabled) {
    if (!isHook) out(t('disabled'));
    return;
  }

  const env = { root, workspace, sessionId: input.session_id || null, event: input.hook_event_name || null, outT: t };
  const results = (await pool(repos, CONCURRENCY, (r) => runRepo(mode, r, env))).filter(Boolean);
  const failed = results.filter((r) => r.error);

  if (mode === 'save') return;

  if (mode === 'reset') {
    out(t('resetDone') + (workspace ? ` (${results.length - failed.length})` : ''));
    for (const f of failed) out(`offscreen: error${f.label ? ` [${f.label}]` : ''}: ${f.error}`);
    return;
  }

  const groups = results.filter((r) => r.sections && r.sections.length);

  if (mode === 'show') {
    const lines = [];
    if (groups.length) lines.push(t('pendingTitle'), render(groups, outCfg.limits, t));
    else lines.push(results.some((r) => r.noBaseline) ? t('noBaseline') : t('pendingNone'));
    for (const f of failed) lines.push(`offscreen: error${f.label ? ` [${f.label}]` : ''}: ${f.error}`);
    lines.push('');
    const hist = results
      .flatMap((r) => (r.history || []).map((h) => ({ ...h, label: r.label })))
      .sort((a, b) => b.at - a.at)
      .slice(0, 5);
    if (!hist.length) lines.push(t('historyNone'));
    else {
      lines.push(t('historyTitle'));
      for (const h of hist) {
        const who = [h.label, h.session ? `session ${String(h.session).slice(0, 8)}` : null].filter(Boolean).join(' · ');
        lines.push('', `[${fmtTime(h.at)}]${who ? ` ${who}` : ''}`, h.text);
      }
    }
    out(lines.join('\n'));
    return;
  }

  // diff
  if (!groups.length) return;
  const payload = {
    hookSpecificOutput: { hookEventName: env.event || 'UserPromptSubmit', additionalContext: render(groups, outCfg.limits, t) },
  };
  if (outCfg.notify) payload.systemMessage = summarize(groups, t);
  out(JSON.stringify(payload));
}

// Hooks time out at 10s; never get killed (that shows up as a failed hook).
setTimeout(() => process.exit(0), 9000).unref();

main()
  .catch(() => {})
  .finally(() => {
    // stdout was written synchronously, so exiting right away loses nothing.
    process.exit(0);
  });
