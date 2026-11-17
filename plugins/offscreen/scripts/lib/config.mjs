// Config: <repo>/.claude|.codex/offscreen.json > ~/.claude|.codex/offscreen.json > defaults.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  enabled: true,
  language: 'en',
  notify: true,
  trackers: ['git'],
  untracked: 'all', // passed to git status --untracked-files (all | normal | no)
  limits: { maxReflog: 15, maxCommits: 10, maxFiles: 30, maxHashFiles: 500, maxHashBytes: 8 * 1024 * 1024, maxChars: 4000 },
  ignore: [],
  // Session folder that is not a repo itself: watch the repositories below it.
  workspace: { scanDepth: 2, maxRepos: 30 },
});

function readFirst(files) {
  for (const f of files) {
    try {
      const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch {}
  }
  return {};
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) continue;
    const b = base[k];
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = merge(b, v);
    } else if (Array.isArray(b)) {
      if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string');
    } else if (typeof v === typeof b) {
      out[k] = v;
    }
  }
  return out;
}

const filesIn = (dir) => [path.join(dir, '.claude', 'offscreen.json'), path.join(dir, '.codex', 'offscreen.json')];

/**
 * dirs: project-level folders, lowest precedence first (e.g. [workspaceRoot, repoRoot]).
 * Each may hold .claude/offscreen.json or .codex/offscreen.json.
 */
export function loadConfig(dirs, home = process.env.OFFSCREEN_HOME || os.homedir()) {
  let cfg = merge(DEFAULTS, readFirst(filesIn(home)));
  for (const d of [...new Set((Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean))]) {
    cfg = merge(cfg, readFirst(filesIn(d)));
  }
  if (!['all', 'normal', 'no'].includes(cfg.untracked)) cfg.untracked = DEFAULTS.untracked;
  return cfg;
}
