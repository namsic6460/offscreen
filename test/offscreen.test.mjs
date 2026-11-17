import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ENV, PLUGIN_ROOT, diff, makeRepo, manual, save, setRepoConfig, tmpDir } from './helpers.mjs';

function baseRepo() {
  const r = makeRepo();
  r.commit('a.txt', 'a\n', 'init');
  assert.equal(diff(r.dir).stdout, '', 'first run must be silent');
  return r;
}

test('1. first run only saves', () => {
  const r = makeRepo();
  r.commit('a.txt', 'a\n', 'init');
  const res = diff(r.dir);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.ok(fs.existsSync(path.join(r.gitDir, 'offscreen', 'snapshot.json')));
  assert.ok(fs.existsSync(path.join(r.gitDir, 'offscreen', 'sessions', 'sess-1.json')));
});

test('2. no change -> no output', () => {
  const r = baseRepo();
  assert.equal(diff(r.dir).stdout, '');
});

test('3. two manual commits -> reflog + new commits', () => {
  const r = baseRepo();
  r.commit('b.txt', 'b\n', 'fix login bug');
  r.commit('c.txt', 'c\n', 'add test');
  const res = diff(r.dir);
  assert.equal(res.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(res.context, /^<offscreen>/);
  assert.match(res.context, /## HEAD movements/);
  assert.equal((res.context.match(/commit: /g) || []).length, 2);
  assert.match(res.context, /## New commits on main \(2\)/);
  assert.match(res.context, /fix login bug/);
  assert.match(res.json.systemMessage, /commits 2/);
});

test('4. branch switch', () => {
  const r = baseRepo();
  r.g('checkout', '-q', '-b', 'feat/x');
  const res = diff(r.dir);
  assert.match(res.context, /## Branch\nmain → feat\/x/);
  assert.match(res.context, /\+ feat\/x/);
  assert.match(res.context, /checkout: moving from main to feat\/x/);
});

test('5. reset --hard HEAD~2 -> moved back', () => {
  const r = baseRepo();
  r.commit('b.txt', 'b\n', 'two');
  r.commit('c.txt', 'c\n', 'three');
  diff(r.dir);
  r.g('reset', '-q', '--hard', 'HEAD~2');
  const res = diff(r.dir);
  assert.match(res.context, /HEAD moved back on main: 2 commit\(s\)/);
  assert.match(res.context, /- [0-9a-f]+ three/);
});

test('6a. commit --amend -> history rewritten', () => {
  const r = baseRepo();
  r.write('a.txt', 'a2\n');
  r.g('commit', '-q', '-a', '--amend', '-m', 'init amended');
  const res = diff(r.dir);
  assert.match(res.context, /History rewritten on main .*1 commit\(s\) dropped, 1 new/);
  assert.match(res.context, /\+ [0-9a-f]+ init amended/);
});

test('6b. rebase -> history rewritten', () => {
  const r = baseRepo();
  r.g('checkout', '-q', '-b', 'feat');
  r.commit('f.txt', 'f\n', 'feature');
  r.g('checkout', '-q', 'main');
  r.commit('m.txt', 'm\n', 'mainline');
  r.g('checkout', '-q', 'feat');
  diff(r.dir);
  r.g('rebase', '-q', 'main');
  const res = diff(r.dir);
  assert.match(res.context, /History rewritten on feat/);
  assert.match(res.context, /rebase/);
});

test('7. already-modified file edited further', () => {
  const r = baseRepo();
  r.write('a.txt', 'a\nmore\n');
  assert.match(diff(r.dir).context, /newly changed: a\.txt \(\.M\)/);
  r.write('a.txt', 'a\nmore\nand more\n');
  const res = diff(r.dir);
  assert.match(res.context, /edited further: a\.txt/);
});

test('8. committing a modified file -> now clean', () => {
  const r = baseRepo();
  r.write('a.txt', 'changed\n');
  diff(r.dir);
  r.g('commit', '-q', '-am', 'commit it');
  const res = diff(r.dir);
  assert.match(res.context, /now clean \(committed or reverted\): a\.txt/);
  assert.match(res.context, /New commits on main \(1\)/);
});

test('9. stash push / pop', () => {
  const r = baseRepo();
  r.write('a.txt', 'dirty\n');
  diff(r.dir);
  r.g('stash', 'push', '-q', '-m', 'wip thing');
  let res = diff(r.dir);
  assert.match(res.context, /## Stash\n\+  stash@\{0\}  On main: wip thing/);
  assert.match(res.context, /now clean.*a\.txt/);
  r.g('stash', 'pop', '-q');
  res = diff(r.dir);
  assert.match(res.context, /On main: wip thing \(popped or dropped\)/);
});

test('10. rebase stopped on conflict -> op warning', () => {
  const r = baseRepo();
  r.g('checkout', '-q', '-b', 'feat');
  r.commit('a.txt', 'feat\n', 'feat change');
  r.g('checkout', '-q', 'main');
  r.commit('a.txt', 'main\n', 'main change');
  r.g('checkout', '-q', 'feat');
  diff(r.dir);
  const reb = spawnSync('git', ['rebase', 'main'], { cwd: r.dir, env: ENV, encoding: 'utf8' });
  assert.notEqual(reb.status, 0);
  let res = diff(r.dir);
  assert.match(res.context, /⚠ rebase in progress/);
  assert.match(res.context, /conflicted: a\.txt/);
  r.g('rebase', '--abort');
  res = diff(r.dir);
  assert.match(res.context, /rebase finished or aborted/);
});

test('11. same change is never reported twice', () => {
  const r = baseRepo();
  r.commit('b.txt', 'b\n', 'x');
  assert.notEqual(diff(r.dir).stdout, '');
  assert.equal(diff(r.dir).stdout, '');
});

test('12. output length cap', () => {
  const r = makeRepo();
  setRepoConfig(r.dir, { limits: { maxChars: 600, maxFiles: 1000 } });
  r.commit('a.txt', 'a\n', 'init');
  diff(r.dir);
  for (let i = 0; i < 200; i++) r.write(`gen/file-with-a-long-name-${i}.txt`, `${i}\n`);
  const res = diff(r.dir);
  assert.ok(res.context.length <= 600, `length ${res.context.length}`);
  assert.match(res.context, /\(truncated — run git status \/ git log for details\)\n<\/offscreen>$/);
});

test('12b. per-group file cap', () => {
  const r = makeRepo();
  setRepoConfig(r.dir, { limits: { maxFiles: 3 } });
  r.commit('a.txt', 'a\n', 'init');
  diff(r.dir);
  for (let i = 0; i < 10; i++) r.write(`n${i}.txt`, 'x');
  assert.match(diff(r.dir).context, /…and 7 more/);
});

test('13. ignore patterns', () => {
  const r = makeRepo();
  setRepoConfig(r.dir, { ignore: ['dist/**', '*.log', '.claude/'] });
  r.commit('a.txt', 'a\n', 'init');
  diff(r.dir);
  r.write('dist/bundle.js', 'x');
  r.write('logs/run.log', 'x');
  r.write('src/keep.ts', 'x');
  const res = diff(r.dir);
  assert.match(res.context, /src\/keep\.ts/);
  assert.doesNotMatch(res.context, /bundle\.js|run\.log|offscreen\.json/);
});

test('14. not a git repo -> silent exit 0', () => {
  const d = tmpDir();
  const res = diff(d);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.equal(save(d).status, 0);
});

test('15. corrupt snapshot is replaced silently', () => {
  const r = baseRepo();
  fs.writeFileSync(path.join(r.gitDir, 'offscreen', 'snapshot.json'), '{not json');
  fs.writeFileSync(path.join(r.gitDir, 'offscreen', 'sessions', 'sess-1.json'), '{"version":999}');
  r.commit('b.txt', 'b\n', 'x');
  const res = diff(r.dir);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  r.commit('c.txt', 'c\n', 'y');
  assert.match(diff(r.dir).context, /New commits on main \(1\)/);
});

test('16. AI changes absorbed by save; other sessions still learn about them', () => {
  const r = baseRepo(); // sess-1 baseline
  assert.equal(diff(r.dir, { session: 'sess-2' }).stdout, ''); // sess-2 baseline (from latest)
  // sess-1's AI commits via a tool, PostToolUse saves for sess-1
  r.commit('ai.txt', 'ai\n', 'ai work');
  save(r.dir, { session: 'sess-1' });
  assert.equal(diff(r.dir, { session: 'sess-1' }).stdout, '', 'own change is not reported');
  assert.match(diff(r.dir, { session: 'sess-2' }).context, /ai work/, 'other session is told');
});

test('17. new session starts from the latest snapshot', () => {
  const r = baseRepo();
  r.commit('b.txt', 'b\n', 'between chats');
  assert.match(diff(r.dir, { session: 'brand-new' }).context, /between chats/);
});

test('18. detached HEAD', () => {
  const r = baseRepo();
  r.commit('b.txt', 'b\n', 'two');
  diff(r.dir);
  r.g('checkout', '-q', 'HEAD~1');
  const res = diff(r.dir);
  assert.match(res.context, /main → \(detached at [0-9a-f]{7}\)/);
});

test('19. empty repo then first commit', () => {
  const r = makeRepo();
  r.write('x.txt', 'x');
  assert.equal(diff(r.dir).stdout, '');
  r.write('y.txt', 'y');
  assert.match(diff(r.dir).context, /newly changed: y\.txt \(\?\?\)/);
  r.g('add', '.');
  r.g('commit', '-q', '-m', 'first');
  const res = diff(r.dir);
  assert.match(res.context, /New commits on main \(1\)/);
  assert.match(res.context, /now clean.*x\.txt, y\.txt/);
});

test('20. language ko + notify off', () => {
  const r = makeRepo();
  setRepoConfig(r.dir, { language: 'ko', notify: false });
  r.commit('a.txt', 'a\n', 'init');
  diff(r.dir);
  r.commit('b.txt', 'b\n', 'x');
  const res = diff(r.dir);
  assert.match(res.context, /main에 추가된 커밋 \(1\)/);
  assert.equal(res.json.systemMessage, undefined);
});

test('21. enabled:false does nothing', () => {
  const r = makeRepo();
  setRepoConfig(r.dir, { enabled: false });
  r.commit('a.txt', 'a\n', 'init');
  diff(r.dir);
  assert.ok(!fs.existsSync(path.join(r.gitDir, 'offscreen')));
});

test('22. show previews without saving; reset re-baselines', () => {
  const r = baseRepo();
  r.commit('b.txt', 'b\n', 'pending one');
  let out = manual(r.dir, 'show').stdout;
  assert.match(out, /Pending changes \(not yet reported\):[\s\S]*pending one/);
  assert.match(out, /Nothing has been reported yet/);
  assert.match(diff(r.dir).context, /pending one/, 'show must not consume the change');
  out = manual(r.dir, 'show').stdout;
  assert.match(out, /Pending changes: none/);
  assert.match(out, /Recently reported to the AI[\s\S]*pending one/);

  r.commit('c.txt', 'c\n', 'to be forgotten');
  assert.match(manual(r.dir, 'reset').stdout, /baseline reset/);
  assert.ok(!fs.existsSync(path.join(r.gitDir, 'offscreen', 'sessions')));
  assert.equal(diff(r.dir).stdout, '');
});

test('23. git error never blocks: exit 0 and error.log', () => {
  const r = baseRepo();
  // Break the index so `git status` fails.
  fs.writeFileSync(path.join(r.gitDir, 'index'), 'garbage');
  const res = diff(r.dir);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(fs.readFileSync(path.join(r.gitDir, 'offscreen', 'error.log'), 'utf8'), /git status/);
});

test('24. Codex uses the shared hooks.json; its command works once the root is substituted', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.hooks, undefined, 'Codex must fall back to hooks/hooks.json');
  assert.ok(new RegExp(JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks.PostToolUse[0].matcher).test('apply_patch'));
  const r = baseRepo();
  r.commit('b.txt', 'b\n', 'via codex');
  const cfg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const command = cfg.hooks.UserPromptSubmit[0].hooks[0].command.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT);
  const res = spawnSync(command, {
    shell: true,
    cwd: r.dir,
    env: ENV,
    input: JSON.stringify({ cwd: r.dir, session_id: 'codex-1', hook_event_name: 'UserPromptSubmit', model: 'gpt-5' }),
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /via codex/);
});

test('25. Claude hook config parses and points at the script', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  for (const ev of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
    assert.match(cfg.hooks[ev][0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/offscreen\.mjs" (diff|save)$/);
  }
  assert.equal(cfg.hooks.PostToolUse[0].hooks[0].async, true);
  const re = new RegExp(cfg.hooks.PostToolUse[0].matcher);
  for (const tool of ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__idea__apply_patch']) assert.ok(re.test(tool), tool);
  for (const tool of ['Read', 'Grep', 'Glob', 'TodoWrite']) assert.ok(!re.test(tool), tool);
});
