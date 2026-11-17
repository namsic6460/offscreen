# offscreen

AI가 응답하지 않는 사이(= AI가 보지 못한 사이)에 저장소가 바뀌면, **다음 프롬프트에 바뀐 부분만** 컨텍스트로 붙여 주는 Claude Code / Codex 플러그인.

터미널에서 직접 커밋·체크아웃·reset·rebase·stash를 하거나 IDE에서 파일을 고친 뒤 AI에게 따로 말하지 않으면, AI는 예전 상태를 가정하고 답하기 쉽습니다. offscreen은 그 변경을 기록해 두었다가 다음 프롬프트 제출 시점에 한 번만 전달합니다.

- 변경이 없으면 아무것도 주입하지 않습니다 (토큰 0).
- 상태가 바뀔 때마다 AI를 호출하지 않습니다. 감지는 프롬프트 제출 시점에 로컬 스크립트로만 합니다.
- 새 채팅에서도 이어집니다. 기준 스냅샷이 저장소의 `.git/offscreen/` 안에 남습니다.
- 다른 세션(다른 Claude/Codex 창)이 바꾼 내용도 "이 대화 밖의 변경"으로 알려 줍니다.
- 프롬프트를 절대 막지 않습니다. 오류가 나도 exit 0, 기록은 `.git/offscreen/error.log`.

## AI가 받는 내용 (예)

```
<offscreen>
The repository changed outside this conversation since your last response (...)
Treat this as the current state; do not assume the earlier state. ...

## HEAD movements (reflog, newest first)
17:02  c3d4e5f  checkout: moving from main to feat/x
17:01  a1b2c3d  commit: fix login bug

## Branch
main → feat/x

## Commits in feat/x that were not in the previous HEAD (2)
HEAD 1234567 → a1b2c3d fix login bug
a1b2c3d fix login bug
9f8e7d6 add test

## Working tree
newly changed: src/auth.ts (.M), src/user.ts (.M)
now clean (committed or reverted): src/old.ts
edited further: README.md

## Stash
+  stash@{0}  WIP on main: 1234567 ...
</offscreen>
```

터미널에는 `offscreen: changes made outside this chat were sent to the AI (commits 2, files 4, ...)` 한 줄 알림이 뜹니다 (`notify: false`로 끔).

## 설치

이 저장소 자체가 Claude Code / Codex 마켓플레이스입니다.

**Claude Code**

```
/plugin marketplace add namsic6460/offscreen
/plugin install offscreen@offscreen
```

로컬 경로로도 됩니다: `/plugin marketplace add ./offscreen` (개발 중엔 `claude --plugin-dir ./plugins/offscreen`).

**Codex**

```bash
codex plugin marketplace add namsic6460/offscreen
```

```bash
codex plugin add offscreen@offscreen
```

그다음 `codex`에서 `/hooks`를 열어 offscreen 훅 3개(UserPromptSubmit·PostToolUse·Stop, `hooks/codex.json`)를 신뢰(trust)해야 실행됩니다. Codex는 플러그인을 `~/.codex/plugins/cache/`에 복사해 쓰므로, 소스를 고친 뒤에는 `codex plugin add`로 다시 설치하고 바뀐 훅을 다시 신뢰해야 합니다.

필요 조건: `node`(18+)와 `git`이 PATH에 있을 것. 외부 의존성은 없습니다.

## 동작 원리

```
[AI 턴]   PostToolUse (Bash/PowerShell/Edit/Write/apply_patch/mcp__*) → save   AI 자신의 변경은 기준선에 흡수
          Stop                                                           → save
[사용자 수동 작업 — 아무것도 실행되지 않음]
[프롬프트 제출]  UserPromptSubmit → diff → 변경이 있으면 additionalContext로 주입 → 즉시 save
```

- 스냅샷: `$(git rev-parse --git-dir)/offscreen/` — 커밋에 섞이지 않고, 저장소·worktree별로 분리됩니다.
  - `sessions/<session_id>.json` — 세션별 기준선 (7일 지나면 정리)
  - `snapshot.json` — 마지막으로 저장된 기준선. 새 세션은 여기서 시작합니다.
  - `history.jsonl` — AI에게 전달한 내역 (최근 50개 유지)
- 추적 항목 (git tracker): HEAD, 현재 브랜치, 로컬 브랜치 목록, stash, 작업 트리(`git status --porcelain=v2`), dirty 파일의 내용 해시(이미 M인 파일의 추가 수정 감지), 진행 중 작업(rebase/merge/cherry-pick/revert/bisect/am)과 충돌 파일.
- reflog는 저장 시점의 최상단 항목을 마커로 기억해 그 이후 항목만 보여 줍니다.
- 원격 조회(fetch, gh API)는 하지 않습니다. 전체 diff도 넣지 않습니다 — 요약만 주고, 상세는 AI가 필요하면 직접 조회합니다.
- `git status`는 `GIT_OPTIONAL_LOCKS=0`으로 실행해 사용자의 git 작업과 index.lock을 다투지 않습니다.

## 스킬 (수동 명령)

| Claude Code | Codex | 동작 |
|---|---|---|
| `/offscreen:offscreen-show` | 스킬 `offscreen-show` | 아직 전달 안 된 변경 미리보기(저장 안 함) + 최근 전달 내역 |
| `/offscreen:offscreen-reset` | 스킬 `offscreen-reset` | 기준선을 현재 상태로 초기화 (모든 세션) |

직접 실행해도 됩니다: `node <plugin>/scripts/offscreen.mjs show --cwd <repo>`.

## 설정

우선순위: `<repo>/.claude/offscreen.json` 또는 `<repo>/.codex/offscreen.json` > `~/.claude/offscreen.json` 또는 `~/.codex/offscreen.json` > 기본값

```json
{
  "enabled": true,
  "language": "en",
  "notify": true,
  "trackers": ["git"],
  "untracked": "all",
  "limits": { "maxReflog": 15, "maxCommits": 10, "maxFiles": 30, "maxHashFiles": 500, "maxHashBytes": 8388608, "maxChars": 4000 },
  "ignore": ["dist/**", "*.log"]
}
```

| 키 | 설명 |
|---|---|
| `language` | `"en"` 또는 `"ko"` — 주입 텍스트·알림 언어 |
| `notify` | 터미널 한 줄 알림 표시 여부 |
| `untracked` | `git status --untracked-files` 값. `all`은 새 디렉터리 안 파일까지 개별 감지, 큰 미추적 트리가 있으면 `normal` 권장 |
| `limits.maxHashFiles` | dirty 파일이 이보다 많으면 내용 해시를 생략 (status 변화만 비교) |
| `limits.maxHashBytes` | 이보다 큰 파일은 내용 대신 크기+mtime으로 비교 |
| `limits.maxChars` | 주입 텍스트 최대 길이. 넘으면 뒤를 자르고 `(truncated …)` 표시 |
| `ignore` | 보고에서 제외할 경로 glob. `*`, `**`, `?` 지원. `/` 없는 패턴(`*.log`, `node_modules`)은 어느 깊이에서든 일치, `/`로 시작하면 저장소 루트 기준 |

## 한계

- **AI 턴 도중의 수동 변경**: AI가 도구를 실행한 직후마다 기준선을 저장하므로, AI가 작업하는 동안 사용자가 동시에 바꾼 내용은 흡수되어 보고되지 않을 수 있습니다.
- **백그라운드 명령**: AI가 백그라운드로 띄운 명령이 턴이 끝난 뒤 저장소를 바꾸면 다음 턴에 "대화 밖 변경"으로 보고됩니다.
- **세션 간 공유**: 같은 저장소의 다른 세션이 바꾼 내용도 보고됩니다(의도된 동작). 표현이 "user or another agent session"인 이유입니다.
- **submodule**: 상위 저장소의 status에 보이는 범위만 추적합니다.
- **대형 저장소**: `git status`가 8초를 넘으면 그 턴은 건너뛰고 `error.log`에 남깁니다.
- **Codex**: 훅은 `/hooks`에서 신뢰해야 동작합니다. Codex CLI 0.167(Windows)과 Claude Code 2.1.325(Windows)에서 실세션으로 검증했습니다.

## 확장 (tracker)

`plugins/offscreen/scripts/trackers/<name>.mjs`에 아래 형태의 모듈을 추가하고 `scripts/offscreen.mjs`의 `TRACKERS`에 등록한 뒤 설정 `trackers`에 이름을 넣습니다.

```js
export default {
  name: 'docker',
  snapshot(ctx) { /* 직렬화 가능한 현재 상태, 해당 없으면 null */ },  // ctx = { cwd, top, gitDir, config, t }
  diff(prev, cur, ctx) { return [{ title: 'Containers', lines: ['+ web (up)'], summary: 'docker' }]; },
};
```

## 개발

```bash
npm test                         # node:test, 임시 git 저장소에서 실제 git 명령으로 검증
claude plugin validate .         # 마켓플레이스·플러그인 매니페스트 검증
```

```
.claude-plugin/marketplace.json     Claude Code 마켓플레이스
.agents/plugins/marketplace.json    Codex 마켓플레이스
plugins/offscreen/
  .claude-plugin/plugin.json        Claude Code 매니페스트 (hooks/hooks.json 사용)
  .codex-plugin/plugin.json         Codex 매니페스트 (hooks/codex.json 사용)
  hooks/hooks.json, hooks/codex.json
  skills/offscreen-show, skills/offscreen-reset
  scripts/offscreen.mjs             진입점: save | diff | show | reset
  scripts/lib/{git,store,config,format,glob}.mjs
  scripts/trackers/git.mjs
test/
```

Codex 훅 명령은 Windows에서 어떤 셸(cmd/PowerShell/sh)로 실행돼도 동작하도록 `node -e "import(...PLUGIN_ROOT...)"` 형태로 되어 있습니다.

## License

MIT
