// Thin wrapper around the git CLI. Never goes through a shell.
import { execFileSync } from 'node:child_process';

const ENV = {
  ...process.env,
  // Read-only commands like `git status` must not grab index.lock and
  // interfere with whatever the user is doing in their own terminal.
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
};

export class GitError extends Error {}

/**
 * Run git and return stdout (utf8).
 * - allowFail: return null when git exits non-zero (timeouts/missing git still throw).
 */
export function git(cwd, args, { timeout = 5000, allowFail = false, input } = {}) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      env: ENV,
      input,
      encoding: 'utf8',
      timeout,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    const timedOut = e.code === 'ETIMEDOUT' || (e.signal && e.status == null);
    if (allowFail && !timedOut && typeof e.status === 'number') return null;
    const why = timedOut ? `timed out after ${timeout}ms` : (e.stderr || e.message || '').toString().trim();
    throw new GitError(`git ${args.join(' ')}: ${why}`);
  }
}

/** Resolve repository paths for cwd, or null when cwd is not inside a work tree. */
export function repoInfo(cwd) {
  let out;
  try {
    out = git(cwd, ['rev-parse', '--absolute-git-dir', '--show-toplevel'], { allowFail: true });
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
