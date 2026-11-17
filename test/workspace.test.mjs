import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { diff, makeRepo, manual, save, setRepoConfig, tmpDir } from './helpers.mjs';

// <ws>/a, <ws>/group/b are repos; <ws>/node_modules/c and <ws>/x/y/z are not scanned.
function workspace() {
  const ws = tmpDir();
  const a = makeRepo(path.join(ws, 'a'));
  const b = makeRepo(path.join(ws, 'group', 'b'));
  const c = makeRepo(path.join(ws, 'node_modules', 'c'));
  const z = makeRepo(path.join(ws, 'x', 'y', 'z'));
  for (const r of [a, b, c, z]) r.commit('f.txt', '1\n', 'init');
  assert.equal(diff(ws).stdout, '', 'first run must be silent');
  return { ws, a, b, c, z };
}

test('W1. folder of repos: each repo is watched and labelled', () => {
  const { ws, a, b, c, z } = workspace();
  a.commit('g.txt', 'g\n', 'work in a');
  b.write('f.txt', '2\n');
  c.commit('h.txt', 'h\n', 'in node_modules');
  z.commit('h.txt', 'h\n', 'too deep');
  const res = diff(ws);
  assert.match(res.context, /# Repository: a\n\n## HEAD movements[\s\S]*work in a/);
  assert.match(res.context, /# Repository: group\/b\n\n## Working tree\nnewly changed: f\.txt \(\.M\)/);
  assert.doesNotMatch(res.context, /in node_modules|too deep/);
  assert.equal(res.json.systemMessage, 'offscreen: changes made outside this chat were sent to the AI (a: commits 1; group/b: files 1)');
  assert.equal(diff(ws).stdout, '', 'not reported twice');
  assert.ok(fs.existsSync(path.join(a.gitDir, 'offscreen', 'history.jsonl')));
});

test('W2. AI changes in any repo are absorbed by save', () => {
  const { ws, a, b } = workspace();
  a.commit('ai.txt', 'ai\n', 'ai commit');
  b.write('ai.txt', 'x');
  save(ws);
  assert.equal(diff(ws).stdout, '');
});

test('W3. session folder from CLAUDE_PROJECT_DIR wins over a cwd that moved into one repo', () => {
  const { ws, a, b } = workspace();
  b.commit('n.txt', 'n\n', 'sibling change');
  const res = diff(a.dir, { env: { CLAUDE_PROJECT_DIR: ws } });
  assert.match(res.context, /# Repository: group\/b[\s\S]*sibling change/);
});

test('W4. a repo that appears later starts silently, then is tracked', () => {
  const { ws } = workspace();
  const d = makeRepo(path.join(ws, 'd'));
  d.commit('f.txt', '1\n', 'init');
  assert.equal(diff(ws).stdout, '');
  d.commit('g.txt', '2\n', 'later work');
  assert.match(diff(ws).context, /# Repository: d[\s\S]*later work/);
});

test('W5. scanDepth 0 disables workspace mode', () => {
  const ws = tmpDir();
  setRepoConfig(ws, { workspace: { scanDepth: 0 } });
  const a = makeRepo(path.join(ws, 'a'));
  a.commit('f.txt', '1\n', 'init');
  diff(ws);
  a.commit('g.txt', '2\n', 'x');
  assert.equal(diff(ws).stdout, '');
  assert.ok(!fs.existsSync(path.join(a.gitDir, 'offscreen')));
});

test('W6. per-repo config: one repo disabled', () => {
  const ws = tmpDir();
  const a = makeRepo(path.join(ws, 'a'));
  const b = makeRepo(path.join(ws, 'b'));
  setRepoConfig(b.dir, { enabled: false });
  a.commit('f.txt', '1\n', 'init');
  b.commit('f.txt', '1\n', 'init');
  diff(ws);
  a.commit('g.txt', '2\n', 'in a');
  b.commit('g.txt', '2\n', 'in b');
  const res = diff(ws);
  assert.match(res.context, /in a/);
  assert.doesNotMatch(res.context, /in b/);
});

test('W7. show and reset cover every repo', () => {
  const { ws, a, b } = workspace();
  a.commit('g.txt', 'g\n', 'pending a');
  b.commit('g.txt', 'g\n', 'pending b');
  const shown = manual(ws, 'show').stdout;
  assert.match(shown, /# Repository: a[\s\S]*pending a[\s\S]*# Repository: group\/b[\s\S]*pending b/);
  assert.match(manual(ws, 'reset').stdout, /baseline reset .*\(2\)/);
  assert.equal(diff(ws).stdout, '');
});

test('W8. folder with no repos at all is silent', () => {
  const ws = tmpDir();
  fs.mkdirSync(path.join(ws, 'empty', 'dir'), { recursive: true });
  const res = diff(ws);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(manual(ws, 'show').stdout, /no git repository at or below/);
});

test('S1. an older background save never overwrites a newer snapshot', async () => {
  const { saveSnapshot, loadSnapshot } = await import('../plugins/offscreen/scripts/lib/store.mjs');
  const d = tmpDir();
  const snap = (ms) => ({ version: 1, savedAt: Math.floor(ms / 1000), takenAtMs: ms, trackers: { git: { mark: ms } } });
  saveSnapshot(d, 's', snap(2000));
  saveSnapshot(d, 's', snap(1000)); // finished late, taken earlier
  assert.equal(loadSnapshot(d, 's').takenAtMs, 2000);
  assert.equal(loadSnapshot(d, null).takenAtMs, 2000);
  saveSnapshot(d, 's', snap(3000));
  assert.equal(loadSnapshot(d, 's').takenAtMs, 3000);
});
