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

export function loadConfig(repoRoot, home = process.env.OFFSCREEN_HOME || os.homedir()) {
  const user = readFirst([path.join(home, '.claude', 'offscreen.json'), path.join(home, '.codex', 'offscreen.json')]);
  const repo = repoRoot ? readFirst([path.join(repoRoot, '.claude', 'offscreen.json'), path.join(repoRoot, '.codex', 'offscreen.json')]) : {};
  const cfg = merge(merge(DEFAULTS, user), repo);
  if (!['all', 'normal', 'no'].includes(cfg.untracked)) cfg.untracked = DEFAULTS.untracked;
  return cfg;
}
