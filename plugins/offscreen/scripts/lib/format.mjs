// Sections -> injected text, length limiting, and i18n.

const STRINGS = {
  en: {
    intro:
      'The repository changed outside this conversation since your last response (manual work by the user, an IDE, or another agent session).\n' +
      'Treat this as the current state; do not assume the earlier state. Run git commands yourself if you need details.',
    reflog: 'HEAD movements (reflog, newest first)',
    branch: 'Branch',
    detached: '(detached at {h})',
    headLine: 'HEAD {from} → {to}',
    headUnborn: 'HEAD is now on an unborn branch (no commits)',
    added: 'New commits on {ref} ({n})',
    addedSwitch: 'Commits in {ref} that were not in the previous HEAD ({n})',
    movedBack: 'HEAD moved back on {ref}: {n} commit(s) no longer on it (reset?)',
    removedSwitch: 'Commits in the previous HEAD that are not in {ref} ({n})',
    diverged: 'History rewritten on {ref} (rebase/amend/reset): {removed} commit(s) dropped, {added} new',
    unknownPrev: 'previous HEAD {h} is no longer available (gc?)',
    branches: 'Local branches',
    stash: 'Stash',
    stashGone: '-  {h} {s} (popped or dropped)',
    worktree: 'Working tree',
    newly: 'newly changed',
    clean: 'now clean (committed or reverted)',
    status: 'status changed',
    edited: 'edited further',
    op: 'In-progress operation',
    opStarted: '⚠ {op} in progress (may be waiting for conflict resolution)',
    opEnded: '{op} finished or aborted',
    conflicts: 'conflicted: {list}',
    more: '…and {n} more',
    truncated: '(truncated — run git status / git log for details)',
    notify: 'offscreen: changes made outside this chat were sent to the AI ({parts})',
    sCommits: 'commits {n}',
    sFiles: 'files {n}',
    sBranch: 'branch',
    sBranches: 'branches',
    sStash: 'stash',
    sOp: '{op}',
    sHead: 'HEAD',
    pendingTitle: 'Pending changes (not yet reported):',
    pendingNone: 'Pending changes: none',
    noBaseline: 'No baseline yet — one will be created on your next prompt.',
    historyTitle: 'Recently reported to the AI (newest first):',
    historyNone: 'Nothing has been reported yet.',
    resetDone: 'offscreen: baseline reset to the current repository state.',
    disabled: 'offscreen is disabled by config (enabled: false).',
    notRepo: 'offscreen: not a git repository: {cwd}',
  },
  ko: {
    intro:
      '마지막 응답 이후 이 대화 밖에서(사용자 수동 작업, IDE, 다른 에이전트 세션 등) 저장소가 변경되었습니다.\n' +
      '아래를 현재 상태로 간주하고 이전 상태를 가정하지 마세요. 자세한 내용이 필요하면 git 명령으로 직접 확인하세요.',
    reflog: 'HEAD 이동 기록 (reflog, 최신순)',
    branch: '브랜치',
    detached: '(detached: {h})',
    headLine: 'HEAD {from} → {to}',
    headUnborn: 'HEAD가 커밋 없는 브랜치를 가리킴',
    added: '{ref}에 추가된 커밋 ({n})',
    addedSwitch: '이전 HEAD에 없던 {ref}의 커밋 ({n})',
    movedBack: '{ref}의 HEAD가 뒤로 이동: 커밋 {n}개 제외됨 (reset?)',
    removedSwitch: '{ref}에 없는 이전 HEAD의 커밋 ({n})',
    diverged: '{ref} 히스토리 재작성 (rebase/amend/reset): 커밋 {removed}개 제거, {added}개 새로 생김',
    unknownPrev: '이전 HEAD {h}를 더 이상 찾을 수 없음 (gc?)',
    branches: '로컬 브랜치',
    stash: 'Stash',
    stashGone: '-  {h} {s} (pop 또는 drop됨)',
    worktree: '작업 트리',
    newly: '새로 변경됨',
    clean: '변경 해제됨 (커밋 또는 되돌림)',
    status: '상태 바뀜',
    edited: '내용 추가 수정됨',
    op: '진행 중인 작업',
    opStarted: '⚠ {op} 진행 중 (충돌 해결 대기 가능)',
    opEnded: '{op} 완료 또는 중단됨',
    conflicts: '충돌: {list}',
    more: '…외 {n}개',
    truncated: '(잘림 — 필요하면 git status/log로 확인)',
    notify: 'offscreen: 채팅 밖 변경 사항을 AI에 전달 ({parts})',
    sCommits: '커밋 {n}',
    sFiles: '파일 {n}',
    sBranch: '브랜치',
    sBranches: '브랜치 목록',
    sStash: 'stash',
    sOp: '{op}',
    sHead: 'HEAD',
    pendingTitle: '아직 전달되지 않은 변경:',
    pendingNone: '아직 전달되지 않은 변경: 없음',
    noBaseline: '기준 스냅샷이 아직 없습니다 — 다음 프롬프트에서 생성됩니다.',
    historyTitle: '최근 AI에 전달한 내역 (최신순):',
    historyNone: '아직 전달한 내역이 없습니다.',
    resetDone: 'offscreen: 기준 스냅샷을 현재 저장소 상태로 초기화했습니다.',
    disabled: 'offscreen이 설정에서 꺼져 있습니다 (enabled: false).',
    notRepo: 'offscreen: git 저장소가 아닙니다: {cwd}',
  },
};

export function makeT(language) {
  const table = STRINGS[language] || STRINGS.en;
  return (key, vars = {}) => {
    const s = table[key] ?? STRINGS.en[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  };
}

/** Keep at most `max` items, appending a "…and N more" line. */
export function capList(items, max, t) {
  if (items.length <= max) return items.slice();
  return [...items.slice(0, max), t('more', { n: items.length - max })];
}

/**
 * sections: [{ title, lines: string[], summary?: string }]
 * Returns the full <offscreen> block, truncated to maxChars.
 */
export function render(sections, { maxChars }, t) {
  const open = '<offscreen>';
  const close = '</offscreen>';
  const body = [t('intro')];
  for (const s of sections) {
    body.push('', `## ${s.title}`, ...s.lines);
  }
  let text = body.join('\n');
  const full = `${open}\n${text}\n${close}`;
  if (full.length <= maxChars) return full;
  const note = t('truncated');
  const budget = Math.max(0, maxChars - open.length - close.length - note.length - 4);
  text = text.slice(0, budget);
  const nl = text.lastIndexOf('\n');
  if (nl > 0) text = text.slice(0, nl);
  return `${open}\n${text}\n${note}\n${close}`;
}

export function summarize(sections, t) {
  const parts = sections.map((s) => s.summary).filter(Boolean);
  return t('notify', { parts: [...new Set(parts)].join(', ') });
}
