// Which repositories to watch for a session folder.
//
//   single - the folder is inside a git repository: watch that one
//   all    - the folder holds up to workspace.maxRepos repositories: watch all of them
//   active - it holds more: watch only the ones the AI read or changed recently (see active.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { repoInfo } from './git.mjs';
import { recentRepos } from './active.mjs';

const SKIP = new Set(['node_modules', 'vendor', 'target', 'build', 'dist', 'out', 'bin', 'obj', '__pycache__', 'venv']);
const SCAN_LIMIT = 2000;

/** Directories under root (depth 1..maxDepth) that contain a `.git` entry. Does not descend into repos. */
export function findRepoDirs(root, maxDepth, limit = SCAN_LIMIT) {
  const found = [];
  let queue = [root];
  for (let depth = 1; depth <= maxDepth && queue.length && found.length < limit; depth++) {
    const next = [];
    for (const dir of queue) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const child = path.join(dir, e.name);
        if (fs.existsSync(path.join(child, '.git'))) {
          found.push(child);
          if (found.length >= limit) break;
        } else if (!SKIP.has(e.name)) {
          next.push(child);
        }
      }
      if (found.length >= limit) break;
    }
    queue = next;
  }
  return found;
}

/** Repo paths for a known top. Skips a git call when `.git` is a plain directory. */
export async function infoFor(top) {
  try {
    if (fs.statSync(path.join(top, '.git')).isDirectory()) return { gitDir: path.join(top, '.git'), top };
  } catch {
    return null;
  }
  const info = await repoInfo(top);
  return info ? { gitDir: path.resolve(info.gitDir), top: path.resolve(info.top) } : null;
}

async function infos(tops) {
  const seen = new Set();
  const out = [];
  for (const info of await Promise.all(tops.map(infoFor))) {
    if (!info || seen.has(info.gitDir)) continue;
    seen.add(info.gitDir);
    out.push(info);
  }
  return out;
}

/** Decide the mode for `root` and return the repositories to watch. */
export async function resolveRepos(root, ws) {
  const own = await repoInfo(root);
  if (own) return { mode: 'single', repos: [{ gitDir: path.resolve(own.gitDir), top: path.resolve(own.top) }] };
  if (ws.scanDepth <= 0) return { mode: 'all', repos: [] };
  const dirs = ws.mode === 'active' ? [] : findRepoDirs(root, ws.scanDepth);
  if (ws.mode === 'all' || (ws.mode !== 'active' && dirs.length <= ws.maxRepos)) {
    return { mode: 'all', repos: await infos(dirs.slice(0, ws.maxRepos)) };
  }
  return { mode: 'active', repos: await infos(recentRepos(root, ws)) };
}

/** Run fn over items with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
