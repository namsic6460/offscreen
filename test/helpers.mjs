import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'offscreen');
export const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'offscreen.mjs');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'offscreen-test-'));
const GITCONFIG = path.join(SANDBOX, 'gitconfig');
fs.writeFileSync(
  GITCONFIG,
  '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n',
);

// Isolate from the developer's own git/offscreen config.
export const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: GITCONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  OFFSCREEN_HOME: SANDBOX,
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
};
delete ENV.CLAUDE_PROJECT_DIR;

export function makeRepo(at) {
  const dir = at || fs.mkdtempSync(path.join(SANDBOX, 'repo-'));
  fs.mkdirSync(dir, { recursive: true });
  const g = (...args) => execFileSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q');
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  const commit = (file, content, msg) => {
    write(file, content);
    g('add', file);
    g('commit', '-q', '-m', msg);
  };
  return { dir, g, write, commit, gitDir: path.join(dir, '.git') };
}

export function tmpDir() {
  return fs.mkdtempSync(path.join(SANDBOX, 'plain-'));
}

/** Run a hook mode with Claude-style stdin; returns { status, stdout, json, context }. */
export function hook(dir, mode, { session = 'sess-1', event = 'UserPromptSubmit', env = {} } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, mode], {
    input: JSON.stringify({ cwd: dir, session_id: session, hook_event_name: event }),
    env: { ...ENV, ...env },
    encoding: 'utf8',
  });
  const stdout = r.stdout.trim();
  let json = null;
  if (stdout) json = JSON.parse(stdout);
  return { status: r.status, stdout, stderr: r.stderr, json, context: json?.hookSpecificOutput?.additionalContext ?? '' };
}

export const diff = (dir, opts) => hook(dir, 'diff', opts);
export const save = (dir, opts) => hook(dir, 'save', { event: 'PostToolUse', ...opts });

export function manual(dir, mode) {
  const r = spawnSync(process.execPath, [SCRIPT, mode, '--cwd', dir], { env: ENV, encoding: 'utf8', input: '' });
  return { status: r.status, stdout: r.stdout };
}

export function setRepoConfig(dir, cfg) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'offscreen.json'), JSON.stringify(cfg));
}
