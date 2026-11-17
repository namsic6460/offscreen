#!/usr/bin/env node
// offscreen entry point: save | diff | show | reset
//
//   save  (hook: PostToolUse, Stop)  - record the current state as this session's baseline
//   diff  (hook: UserPromptSubmit)   - report what changed since the baseline, then save
//   show  (manual)                   - preview pending changes + recently reported history
//   reset (manual)                   - make the current state the baseline for every session
//
// Hooks must never block the user: every path exits 0, errors go to <git-dir>/offscreen/error.log.
import fs from 'node:fs';
import { repoInfo } from './lib/git.mjs';
import { loadConfig } from './lib/config.mjs';
import { makeT, render, summarize } from './lib/format.mjs';
import { SNAPSHOT_VERSION, appendHistory, loadSnapshot, logError, readHistory, resetSnapshots, saveSnapshot } from './lib/store.mjs';
import gitTracker from './trackers/git.mjs';

const TRACKERS = { git: gitTracker };
const MODES = ['save', 'diff', 'show', 'reset'];

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.pause();
      process.stdin.unref?.();
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
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

function takeSnapshot(ctx) {
  const trackers = {};
  for (const name of ctx.config.trackers) {
    const tr = TRACKERS[name];
    if (!tr) continue;
    const s = tr.snapshot(ctx); // throws on git failure/timeout -> caller skips this turn
    if (s != null) trackers[name] = s;
  }
  return { version: SNAPSHOT_VERSION, savedAt: Math.floor(Date.now() / 1000), trackers };
}

function diffSnapshots(prev, cur, ctx) {
  const sections = [];
  for (const name of ctx.config.trackers) {
    const tr = TRACKERS[name];
    if (!tr || !prev.trackers[name] || !cur.trackers[name]) continue;
    sections.push(...tr.diff(prev.trackers[name], cur.trackers[name], { ...ctx, prevSavedAt: prev.savedAt }));
  }
  return sections;
}

function fmtTime(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
  const cwd = argValue(args, '--cwd') || input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = input.session_id || null;

  const info = repoInfo(cwd);
  if (!info) {
    if (!isHook) out(makeT('en')('notRepo', { cwd }));
    return;
  }
  const config = loadConfig(info.top);
  const t = makeT(config.language);
  if (!config.enabled) {
    if (!isHook) out(t('disabled'));
    return;
  }
  const ctx = { cwd, top: info.top, gitDir: info.gitDir, config, t };

  try {
    if (mode === 'save') {
      saveSnapshot(info.gitDir, sessionId, takeSnapshot(ctx));
      return;
    }

    if (mode === 'reset') {
      resetSnapshots(info.gitDir, takeSnapshot(ctx));
      out(t('resetDone'));
      return;
    }

    if (mode === 'show') {
      const prev = loadSnapshot(info.gitDir, null);
      const lines = [];
      if (!prev) lines.push(t('noBaseline'));
      else {
        const sections = diffSnapshots(prev, takeSnapshot(ctx), ctx);
        if (sections.length) lines.push(t('pendingTitle'), render(sections, config.limits, t));
        else lines.push(t('pendingNone'));
      }
      lines.push('');
      const hist = readHistory(info.gitDir, 5);
      if (!hist.length) lines.push(t('historyNone'));
      else {
        lines.push(t('historyTitle'));
        for (const h of hist) lines.push('', `[${fmtTime(h.at)}]${h.session ? ` session ${String(h.session).slice(0, 8)}` : ''}`, h.text);
      }
      out(lines.join('\n'));
      return;
    }

    // mode === 'diff'
    const prev = loadSnapshot(info.gitDir, sessionId);
    const cur = takeSnapshot(ctx);
    const sections = prev ? diffSnapshots(prev, cur, ctx) : []; // first run / corrupt snapshot: just save
    saveSnapshot(info.gitDir, sessionId, cur); // so the same change is never reported twice
    if (!sections.length) return;

    const text = render(sections, config.limits, t);
    const payload = {
      hookSpecificOutput: { hookEventName: input.hook_event_name || 'UserPromptSubmit', additionalContext: text },
    };
    if (config.notify) payload.systemMessage = summarize(sections, t);
    out(JSON.stringify(payload));
    try {
      appendHistory(info.gitDir, { at: cur.savedAt, session: sessionId, event: input.hook_event_name || null, text });
    } catch (e) {
      logError(info.gitDir, e);
    }
  } catch (e) {
    logError(info.gitDir, e);
    if (!isHook) out(`offscreen: error: ${e.message}`);
  }
}

main()
  .catch(() => {})
  .finally(() => {
    process.exitCode = 0;
  });
