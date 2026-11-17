import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeMatcher } from '../plugins/offscreen/scripts/lib/glob.mjs';

test('glob matcher', () => {
  const m = makeMatcher(['dist/**', '*.log', 'node_modules', 'build/', 'src/**/gen/*.ts', '/root-only.txt']);
  const yes = ['dist/a.js', 'dist/x/y.js', 'a.log', 'deep/dir/b.log', 'node_modules/x/y.js', 'pkg/node_modules/z', 'build/out.bin', 'src/gen/a.ts', 'src/a/b/gen/c.ts', 'root-only.txt'];
  const no = ['src/dist/a.js', 'a.log.txt', 'src/gen/a.js', 'nested/root-only.txt', 'builds/x', 'distx/a.js'];
  for (const f of yes) assert.ok(m(f), `should match ${f}`);
  for (const f of no) assert.ok(!m(f), `should not match ${f}`);
  assert.equal(makeMatcher([])('anything'), false);
});
