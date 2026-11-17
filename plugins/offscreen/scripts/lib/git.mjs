// Thin async wrapper around the git CLI. Never goes through a shell.
// Async so several repositories (workspace mode) can be inspected in parallel.
import { execFile } from 'node:child_process';

const ENV = {
  ...process.env,
  // Read-only commands like `git status` must not grab index.lock and
  // interfere with whatever the user is doing in their own terminal.
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
};

export class GitError extends Error {}

/**
 * Run git and resolve stdout (utf8).
 * - allowFail: resolve null when git exits non-zero (timeouts/missing git still reject).
 */
export function git(cwd, args, { timeout = 5000, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd, env: ENV, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const timedOut = err.killed || err.signal != null;
        if (allowFail && !timedOut && typeof err.code === 'number') return resolve(null);
        const why = timedOut ? `timed out after ${timeout}ms` : (stderr || err.message || '').toString().trim();
        reject(new GitError(`git ${args.join(' ')}: ${why}`));
      },
    );
  });
}

/** Resolve repository paths for cwd, or null when cwd is not inside a work tree. */
export async function repoInfo(cwd) {
  let out;
  try {
    out = await git(cwd, ['rev-parse', '--absolute-git-dir', '--show-toplevel'], { allowFail: true });
  } catch {
    return null; // git missing, cwd missing, ...
  }
  if (!out) return null;
  const [gitDir, top] = out.split(/\r?\n/);
  if (!gitDir || !top) return null;
  return { gitDir, top };
}

export function short(hash) {
  return hash ? hash.slice(0, 7) : '(none)';
}
