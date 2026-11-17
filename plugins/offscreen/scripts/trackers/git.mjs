// git tracker: HEAD / branch / local branches / stash / working tree / in-progress ops.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git, short } from '../lib/git.mjs';
import { makeMatcher } from '../lib/glob.mjs';
import { capList } from '../lib/format.mjs';

// ---------------------------------------------------------------- snapshot

function parseStatus(out) {
  const toks = out.split('\0');
  let head = null;
  let branch = '';
  const entries = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (!tok) continue;
    if (tok.startsWith('# branch.oid ')) {
      const v = tok.slice(13);
      head = v === '(initial)' ? null : v;
    } else if (tok.startsWith('# branch.head ')) {
      const v = tok.slice(14);
      branch = v === '(detached)' ? '' : v;
    } else if (tok.startsWith('# ')) {
      // other headers
    } else if (tok.startsWith('1 ')) {
      const f = tok.split(' ');
      entries.push({ path: f.slice(8).join(' '), st: f[1] });
    } else if (tok.startsWith('2 ')) {
      const f = tok.split(' ');
      entries.push({ path: f.slice(9).join(' '), st: f[1], from: toks[++i] });
    } else if (tok.startsWith('u ')) {
      const f = tok.split(' ');
      entries.push({ path: f.slice(10).join(' '), st: f[1], conflict: true });
    } else if (tok.startsWith('? ')) {
      entries.push({ path: tok.slice(2), st: '??' });
    }
  }
  return { head, branch, entries };
}

function hashFile(abs, maxBytes) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return undefined;
  }
  if (!st.isFile()) return undefined; // dirs (submodules), symlinks: status only
  if (st.size > maxBytes) return `s:${st.size}:${Math.trunc(st.mtimeMs)}`;
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
  } catch {
    return undefined;
  }
}

function detectOp(gitDir) {
  const has = (p) => fs.existsSync(path.join(gitDir, p));
  if (has('rebase-merge')) return 'rebase';
  if (has('rebase-apply')) return has('rebase-apply/applying') ? 'am' : 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  if (has('BISECT_LOG')) return 'bisect';
  return null;
}

function snapshot(ctx) {
  const { cwd, top, gitDir, config } = ctx;
  const L = config.limits;
  const ignored = makeMatcher(config.ignore);

  const status = parseStatus(git(cwd, ['status', '--porcelain=v2', '--branch', '-z', `--untracked-files=${config.untracked}`], { timeout: 8000 }));

  const files = {};
  const toHash = [];
  for (const e of status.entries) {
    if (ignored(e.path)) continue;
    const rec = { st: e.st };
    if (e.from) rec.from = e.from;
    if (e.conflict) rec.c = 1;
    files[e.path] = rec;
    if (e.st[1] !== 'D' && !e.path.endsWith('/')) toHash.push(e.path);
  }
  const hashed = toHash.length <= L.maxHashFiles;
  if (hashed) {
    for (const p of toHash) {
      const h = hashFile(path.join(top, p), L.maxHashBytes);
      if (h) files[p].h = h;
    }
  }

  const branches = {};
  let hasStash = false;
  const refs = git(cwd, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads', 'refs/stash']);
  for (const line of refs.split('\n')) {
    if (!line) continue;
    const [ref, oid] = line.split('\t');
    if (ref === 'refs/stash') hasStash = true;
    else if (ref.startsWith('refs/heads/')) branches[ref.slice(11)] = oid;
  }

  const stash = [];
  if (hasStash) {
    const out = git(cwd, ['stash', 'list', '--format=%H%x09%gs'], { allowFail: true }) || '';
    for (const line of out.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      stash.push({ h: line.slice(0, tab), s: line.slice(tab + 1) });
    }
  }

  // Newest reflog entry at save time: diff lists entries above this marker, which is
  // exact even when the user acts within the same second as the save.
  const top1 = git(cwd, [...REFLOG, '-n', '1', 'HEAD', '--'], { allowFail: true });
  const reflogTop = top1 ? top1.split('\n')[0] || null : null;

  return { head: status.head, branch: status.branch, branches, stash, files, hashed, op: detectOp(gitDir), reflogTop };
}

// --date=unix makes %gd render as HEAD@{<unix ts>} (stable), not HEAD@{<index>}.
const REFLOG = ['reflog', 'show', '--date=unix', '--format=%gd%x09%h%x09%gs'];

// -------------------------------------------------------------------- diff

const dotted = (st) => st.replace(/ /g, '.');

function oneline(cwd, range, max) {
  const out = git(cwd, ['log', '--no-decorate', '--format=%h %s', '-n', String(max), range, '--'], { allowFail: true });
  return out ? out.split('\n').filter(Boolean) : [];
}

function count(cwd, range) {
  const out = git(cwd, ['rev-list', '--count', range, '--'], { allowFail: true });
  return out ? parseInt(out, 10) || 0 : 0;
}

function isAncestor(cwd, a, b) {
  return git(cwd, ['merge-base', '--is-ancestor', a, b], { allowFail: true }) !== null;
}

function commitExists(cwd, h) {
  return git(cwd, ['cat-file', '-e', `${h}^{commit}`], { allowFail: true }) !== null;
}

function reflogSection(prev, cur, ctx, t) {
  const { cwd, prevSavedAt, config } = ctx;
  if (prev.reflogTop === cur.reflogTop) return null;
  const out = git(cwd, [...REFLOG, '-n', String(config.limits.maxReflog + 50), 'HEAD', '--'], { allowFail: true });
  if (!out) return null;
  const all = out.split('\n').filter(Boolean);
  // Marker found -> everything above it is new. Not found (expired, rewritten, first
  // snapshot without a marker) -> fall back to the timestamp.
  const markerAt = prev.reflogTop ? all.indexOf(prev.reflogTop) : -1;
  const lines = [];
  for (const [i, line] of all.entries()) {
    const m = /^[^@]*@\{(\d+)\}\t([^\t]*)\t(.*)$/.exec(line);
    if (!m) continue;
    if (markerAt >= 0 ? i >= markerAt : Number(m[1]) <= prevSavedAt) break; // newest first
    const time = new Date(Number(m[1]) * 1000);
    const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
    lines.push(`${hhmm}  ${m[2]}  ${m[3]}`);
  }
  if (!lines.length) return null;
  return { title: t('reflog'), lines: capList(lines, config.limits.maxReflog, t) };
}

function refLabel(snap, t) {
  return snap.branch || t('detached', { h: short(snap.head) });
}

function headSections(prev, cur, ctx, t) {
  const { cwd, config } = ctx;
  const max = config.limits.maxCommits;
  if (prev.head === cur.head) return [];
  const switched = prev.branch !== cur.branch;
  const ref = refLabel(cur, t);
  const subject = cur.head ? (git(cwd, ['log', '-1', '--format=%s', cur.head, '--'], { allowFail: true }) || '').trim() : '';
  const headLine = cur.head
    ? t('headLine', { from: short(prev.head), to: `${short(cur.head)} ${subject}`.trim() })
    : t('headUnborn');
  const sec = (title, lines, summary) => ({ title, lines, summary });

  if (!cur.head) return [sec(t('sHead'), [headLine], t('sHead'))];
  if (!prev.head) {
    const n = count(cwd, cur.head);
    return [sec(t(switched ? 'addedSwitch' : 'added', { ref, n }), [headLine, ...withMore(oneline(cwd, cur.head, max), n, max, t)], t('sCommits', { n }))];
  }
  if (!commitExists(cwd, prev.head)) {
    return [sec(t('sHead'), [headLine, t('unknownPrev', { h: short(prev.head) })], t('sHead'))];
  }
  const range = (a, b) => `${a}..${b}`;
  if (isAncestor(cwd, prev.head, cur.head)) {
    const n = count(cwd, range(prev.head, cur.head));
    const list = withMore(oneline(cwd, range(prev.head, cur.head), max), n, max, t);
    return [sec(t(switched ? 'addedSwitch' : 'added', { ref, n }), [headLine, ...list], t('sCommits', { n }))];
  }
  if (isAncestor(cwd, cur.head, prev.head)) {
    const n = count(cwd, range(cur.head, prev.head));
    const list = withMore(oneline(cwd, range(cur.head, prev.head), max), n, max, t).map((l) => `- ${l}`);
    return [sec(t(switched ? 'removedSwitch' : 'movedBack', { ref, n }), [headLine, ...list], t('sHead'))];
  }
  const added = count(cwd, range(prev.head, cur.head));
  const removed = count(cwd, range(cur.head, prev.head));
  const plus = withMore(oneline(cwd, range(prev.head, cur.head), max), added, max, t).map((l) => `+ ${l}`);
  const minus = withMore(oneline(cwd, range(cur.head, prev.head), max), removed, max, t).map((l) => `- ${l}`);
  if (switched) {
    return [
      sec(t('addedSwitch', { ref, n: added }), [headLine, ...plus], t('sCommits', { n: added })),
      sec(t('removedSwitch', { ref, n: removed }), minus),
    ];
  }
  return [sec(t('diverged', { ref, added, removed }), [headLine, ...plus, ...minus], t('sCommits', { n: added }))];
}

function withMore(list, total, max, t) {
  return total > list.length && list.length >= max ? [...list, t('more', { n: total - list.length })] : list;
}

function branchSections(prev, cur, t) {
  const out = [];
  if (prev.branch !== cur.branch) {
    out.push({ title: t('branch'), lines: [`${refLabel(prev, t)} → ${refLabel(cur, t)}`], summary: t('sBranch') });
  }
  const lines = [];
  for (const [name, oid] of Object.entries(cur.branches)) {
    const old = prev.branches[name];
    if (!old) lines.push(`+ ${name} (${short(oid)})`);
    else if (old !== oid && !(name === cur.branch && name === prev.branch)) lines.push(`~ ${name} ${short(old)} → ${short(oid)}`);
  }
  for (const [name, oid] of Object.entries(prev.branches)) {
    if (!(name in cur.branches)) lines.push(`- ${name} (${short(oid)})`);
  }
  if (lines.length) out.push({ title: t('branches'), lines, summary: t('sBranches') });
  return out;
}

function stashSection(prev, cur, t) {
  const before = new Set(prev.stash.map((s) => s.h));
  const after = new Set(cur.stash.map((s) => s.h));
  const lines = [];
  cur.stash.forEach((s, i) => {
    if (!before.has(s.h)) lines.push(`+  stash@{${i}}  ${s.s}`);
  });
  for (const s of prev.stash) {
    if (!after.has(s.h)) lines.push(t('stashGone', { h: short(s.h), s: s.s }));
  }
  return lines.length ? { title: t('stash'), lines, summary: t('sStash') } : null;
}

function opSection(prev, cur, t) {
  const lines = [];
  if (prev.op !== cur.op) {
    if (prev.op) lines.push(t('opEnded', { op: prev.op }));
    if (cur.op) lines.push(t('opStarted', { op: cur.op }));
  }
  const conflicted = (s) => Object.keys(s.files).filter((p) => s.files[p].c).sort();
  const nowC = conflicted(cur);
  if (nowC.join('\0') !== conflicted(prev).join('\0') && nowC.length) {
    lines.push(t('conflicts', { list: nowC.join(', ') }));
  }
  if (!lines.length) return null;
  return { title: t('op'), lines, summary: cur.op ? t('sOp', { op: cur.op }) : null };
}

function filesSection(prev, cur, ctx, t) {
  const max = ctx.config.limits.maxFiles;
  const ignored = makeMatcher(ctx.config.ignore);
  const newly = [];
  const clean = [];
  const status = [];
  const edited = [];
  for (const [p, c] of Object.entries(cur.files)) {
    if (ignored(p)) continue;
    const o = prev.files[p];
    if (!o) newly.push(`${p} (${dotted(c.st)}${c.from ? ` ← ${c.from}` : ''})`);
    else if (o.st !== c.st) status.push(`${p} (${dotted(o.st)} → ${dotted(c.st)})`);
    else if (o.h && c.h && o.h !== c.h) edited.push(p);
  }
  for (const p of Object.keys(prev.files)) {
    if (!(p in cur.files) && !ignored(p)) clean.push(p);
  }
  const total = newly.length + clean.length + status.length + edited.length;
  if (!total) return null;
  const lines = [];
  const group = (key, items) => {
    if (items.length) lines.push(`${t(key)}: ${capList(items.sort(), max, t).join(', ')}`);
  };
  group('newly', newly);
  group('clean', clean);
  group('status', status);
  group('edited', edited);
  return { title: t('worktree'), lines, summary: t('sFiles', { n: total }) };
}

function diff(prev, cur, ctx) {
  const t = ctx.t;
  const sections = [];
  const reflog = reflogSection(prev, cur, ctx, t);
  const heads = headSections(prev, cur, ctx, t);
  if (reflog) sections.push(reflog);
  sections.push(...branchSections(prev, cur, t));
  sections.push(...heads);
  const op = opSection(prev, cur, t);
  if (op) sections.push(op);
  const files = filesSection(prev, cur, ctx, t);
  if (files) sections.push(files);
  const stash = stashSection(prev, cur, t);
  if (stash) sections.push(stash);
  // A reflog entry alone (e.g. commit then reset back to the same HEAD) is still worth reporting.
  return sections;
}

export default { name: 'git', snapshot, diff };
