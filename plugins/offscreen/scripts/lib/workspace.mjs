// Workspace mode: when the session folder is not itself inside a git repository
// (e.g. a folder that holds many repositories), find the repositories below it.
import fs from 'node:fs';
import path from 'node:path';
import { repoInfo } from './git.mjs';

const SKIP = new Set(['node_modules', 'vendor', 'target', 'build', 'dist', 'out', 'bin', 'obj', '__pycache__', 'venv']);

/** Directories under root (depth 1..maxDepth) that contain a `.git` entry. Does not descend into repos. */
export function findRepoDirs(root, maxDepth, maxRepos) {
  const found = [];
  let queue = [root];
  for (let depth = 1; depth <= maxDepth && queue.length && found.length < maxRepos; depth++) {
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
          if (found.length >= maxRepos) break;
        } else if (!SKIP.has(e.name)) {
          next.push(child);
        }
      }
      if (found.length >= maxRepos) break;
    }
    queue = next;
  }
  return found;
}

/**
 * Repositories to watch for `root`.
 * - root inside a repo -> [that repo], workspace = false
 * - otherwise          -> repos found below root, workspace = true
 */
export async function resolveRepos(root, { scanDepth, maxRepos }) {
  const own = await repoInfo(root);
  if (own) return { workspace: false, repos: [own] };
  if (scanDepth <= 0) return { workspace: true, repos: [] };
  const dirs = findRepoDirs(root, scanDepth, maxRepos);
  const infos = await Promise.all(dirs.map((d) => repoInfo(d)));
  const seen = new Set();
  const repos = [];
  for (const info of infos) {
    if (!info || seen.has(info.gitDir)) continue;
    seen.add(info.gitDir);
    repos.push(info);
  }
  return { workspace: true, repos };
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
