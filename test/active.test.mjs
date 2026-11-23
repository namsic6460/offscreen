import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { diff, makeRepo, manual, save, setRepoConfig, tmpDir } from './helpers.mjs';
import { touchedRepos } from '../plugins/offscreen/scripts/lib/active.mjs';

// Five repos but maxRepos 2 -> active mode: only repos the AI used are watched.
function bigWorkspace() {
  const ws = tmpDir();
  setRepoConfig(ws, { workspace: { maxRepos: 2 } });
  const r = {};
  for (const name of ['a', 'b', 'c', 'd', 'group/e']) {
    r[name] = makeRepo(path.join(ws, ...name.split('/')));
    r[name].commit('f.txt', '1\n', 'init');
  }
  assert.equal(diff(ws).stdout, '', 'nothing used yet -> silent');
  return { ws, r };
}

const tool = (ws, tool_name, tool_input, opts = {}) => save(ws, { extra: { tool_name, tool_input }, ...opts });

test('A1. unused repos are not watched in a big workspace', () => {
  const { ws, r } = bigWorkspace();
  r.a.commit('g.txt', '2\n', 'nobody asked');
  assert.equal(diff(ws).stdout, '');
  assert.ok(!fs.existsSync(path.join(r.a.gitDir, 'offscreen')), 'no snapshot written for unused repos');
  assert.match(manual(ws, 'show').stdout, /only the ones the AI reads or changes/);
});

test('A2. a Read marks the repo; later manual changes there are reported', () => {
  const { ws, r } = bigWorkspace();
  tool(ws, 'Read', { file_path: path.join(r.b.dir, 'f.txt') });
  r.b.commit('g.txt', '2\n', 'manual after read');
  r.c.commit('g.txt', '2\n', 'other repo');
  const res = diff(ws);
  assert.match(res.context, /# Repository: b[\s\S]*manual after read/);
  assert.doesNotMatch(res.context, /other repo/);
});

test('A3. the AI\'s own edits in a used repo are absorbed', () => {
  const { ws, r } = bigWorkspace();
  tool(ws, 'Read', { file_path: path.join(r.c.dir, 'f.txt') });
  r.c.write('f.txt', 'ai edit\n');
  tool(ws, 'Edit', { file_path: path.join(r.c.dir, 'f.txt'), old_string: '1', new_string: 'ai edit' });
  assert.equal(diff(ws).stdout, '');
});

test('A4. Bash: the working directory and paths in the command count', () => {
  const { ws, r } = bigWorkspace();
  // Claude Code: the session folder comes from CLAUDE_PROJECT_DIR, `cwd` follows `cd`.
  tool(ws, 'Bash', null, { env: { CLAUDE_PROJECT_DIR: ws }, extra: { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: r.d.dir } });
  tool(ws, 'Bash', { command: `git -C "${path.join(ws, 'group', 'e')}" log -1` });
  r.d.commit('g.txt', '2\n', 'in d');
  r['group/e'].commit('g.txt', '2\n', 'in e');
  const res = diff(ws);
  assert.match(res.context, /# Repository: d[\s\S]*in d/);
  assert.match(res.context, /# Repository: group\/e[\s\S]*in e/);
});

test('A5. a new chat keeps watching recently used repos', () => {
  const { ws, r } = bigWorkspace();
  tool(ws, 'Edit', { file_path: path.join(r.a.dir, 'f.txt') });
  diff(ws);
  r.a.commit('g.txt', '2\n', 'between chats');
  assert.match(diff(ws, { session: 'next-chat' }).context, /# Repository: a[\s\S]*between chats/);
});

test('A6. recentDays 0 forgets used repos', () => {
  const ws = tmpDir();
  setRepoConfig(ws, { workspace: { maxRepos: 1, recentDays: 0 } });
  const a = makeRepo(path.join(ws, 'a'));
  const b = makeRepo(path.join(ws, 'b'));
  a.commit('f.txt', '1\n', 'init');
  b.commit('f.txt', '1\n', 'init');
  save(ws, { extra: { tool_name: 'Read', tool_input: { file_path: path.join(a.dir, 'f.txt') } } });
  a.commit('g.txt', '2\n', 'x');
  assert.equal(diff(ws).stdout, '');
});

test('A7. small workspaces still watch every repo; reads cost nothing there', () => {
  const ws = tmpDir();
  const a = makeRepo(path.join(ws, 'a'));
  a.commit('f.txt', '1\n', 'init');
  diff(ws);
  const snap = path.join(a.gitDir, 'offscreen', 'snapshot.json');
  const before = fs.statSync(snap).mtimeMs;
  save(ws, { extra: { tool_name: 'Read', tool_input: { file_path: path.join(a.dir, 'f.txt') } } });
  assert.equal(fs.statSync(snap).mtimeMs, before, 'read-only tool must not rewrite snapshots');
  a.commit('g.txt', '2\n', 'untouched but small workspace');
  assert.match(diff(ws).context, /untouched but small workspace/);
});

test('A8. touchedRepos understands patches, Git Bash paths and ignores outside paths', () => {
  const ws = tmpDir();
  const a = makeRepo(path.join(ws, 'a'));
  const b = makeRepo(path.join(ws, 'b'));
  const outside = makeRepo();
  const tops = (input) => touchedRepos({ cwd: ws, ...input }, ws).map((p) => path.basename(p)).sort();
  assert.deepEqual(tops({ tool_input: { input: `*** Begin Patch\n*** Update File: ${path.join(a.dir, 'x.ts')}\n@@\n*** End Patch` } }), ['a']);
  assert.deepEqual(tops({ tool_input: { input: '*** Begin Patch\n*** Add File: b/new.ts\n*** End Patch' } }), ['b']);
  assert.deepEqual(tops({ tool_input: { command: `cat ${path.join(outside.dir, 'f.txt')}` } }), []);
  assert.deepEqual(tops({ tool_input: { command: 'cd a && git log' } }), ['a']);
  assert.deepEqual(tops({ tool_input: { command: 'echo nothing here' } }), []);
  if (process.platform === 'win32') {
    const posix = '/' + a.dir[0].toLowerCase() + a.dir.slice(2).replace(/\\/g, '/');
    assert.deepEqual(tops({ tool_input: { command: `ls ${posix}/src` } }), ['a']);
  }
});

test('A9. workspace.mode "all" keeps the old cap behaviour', () => {
  const ws = tmpDir();
  setRepoConfig(ws, { workspace: { maxRepos: 1, mode: 'all' } });
  const a = makeRepo(path.join(ws, 'a'));
  const b = makeRepo(path.join(ws, 'b'));
  a.commit('f.txt', '1\n', 'init');
  b.commit('f.txt', '1\n', 'init');
  diff(ws);
  a.commit('g.txt', '2\n', 'first repo');
  b.commit('g.txt', '2\n', 'second repo');
  const res = diff(ws);
  assert.match(res.context, /first repo/);
  assert.doesNotMatch(res.context, /second repo/);
});
