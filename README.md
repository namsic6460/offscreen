# offscreen

AI가 보지 못한 사이에 저장소가 바뀌면, **다음 프롬프트에 바뀐 부분만** 알려 주는 Claude Code / Codex 플러그인.

터미널에서 직접 커밋·브랜치 전환·reset·rebase·stash를 하거나 IDE에서 파일을 고친 뒤 AI에게 따로 말하지 않으면, AI는 예전 상태를 가정하고 답하기 쉽습니다. offscreen은 그런 변경을 기록해 두었다가 다음 프롬프트를 보낼 때 한 번만 전달합니다.

- 바뀐 게 없으면 아무것도 붙이지 않습니다 (토큰 0).
- 변경이 생길 때마다 AI를 호출하지 않습니다. 확인은 프롬프트를 보낼 때 로컬에서만 합니다.
- 새 채팅을 열어도 이어집니다. 이전 채팅 이후의 변경을 알려 줍니다.
- 다른 Claude/Codex 창에서 바뀐 내용도 "이 대화 밖의 변경"으로 알려 줍니다.
- 저장소들을 모아 둔 상위 폴더에서 세션을 열면 하위 저장소들을 함께 감시합니다.
- 프롬프트를 막지 않습니다. 문제가 생겨도 조용히 건너뜁니다.

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

이때 터미널에는 `offscreen: changes made outside this chat were sent to the AI (commits 2, files 4, ...)` 한 줄 알림이 뜹니다.

## 설치

필요 조건: `node`(18 이상)와 `git`이 PATH에 있어야 합니다.

**Claude Code**

```
/plugin marketplace add namsic6460/offscreen
/plugin install offscreen@offscreen
```

**Codex**

```bash
codex plugin marketplace add namsic6460/offscreen
```

```bash
codex plugin add offscreen@offscreen
```

Codex는 플러그인 훅을 사용자가 승인해야 실행합니다. `codex`를 열고 `/hooks`에서 offscreen 훅 3개를 신뢰(trust)하세요.

## 업데이트

**Claude Code** — 실행한 뒤 Claude Code를 다시 시작하세요.

```bash
claude plugin marketplace update offscreen
```

```bash
claude plugin update offscreen@offscreen
```

**Codex**

```bash
codex plugin marketplace upgrade offscreen
```

```bash
codex plugin add offscreen@offscreen
```

업데이트하면 Codex가 훅을 다시 승인받으려 합니다. `/hooks`에서 offscreen 훅을 다시 신뢰하세요. 승인할 항목이 보이지 않는데 훅이 동작하지 않으면, 실행 중인 Codex(데스크톱 앱 포함)를 모두 종료한 뒤 다시 열고 `/hooks`를 확인하세요.

## 무엇을 알려 주나

AI가 마지막으로 작업을 마친 시점과 비교해, 그 사이에 생긴 변경을 알려 줍니다. AI 자신이 한 변경은 제외됩니다.

| 항목 | 내용 |
|---|---|
| HEAD 이동 기록 | commit, checkout/switch, reset, rebase, merge, pull, cherry-pick, amend 등 |
| 커밋 변화 | 새 커밋 / 되돌린 커밋(reset) / 히스토리 재작성(rebase·amend)과 해당 커밋 목록 |
| 브랜치 | 현재 브랜치 전환, detached HEAD, 로컬 브랜치 생성·삭제·이동 |
| 작업 트리 | 새로 바뀐 파일, 커밋·되돌림으로 깨끗해진 파일, stage 상태 변화, 이미 수정된 파일의 추가 수정 |
| stash | push, pop·drop |
| 진행 중 작업 | rebase/merge/cherry-pick/revert/bisect 시작·종료, 충돌 파일 |

알려 주지 않는 것:

- 원격 상태 (`fetch`만 한 경우, `origin/*` 브랜치). 원격 서버에는 접속하지 않습니다.
- 태그, git 설정, `.gitignore`에 걸린 파일, submodule 내부
- 파일 내용 자체 (어떤 파일이 바뀌었는지만 알려 주고, 자세한 내용은 AI가 필요하면 직접 확인합니다)

### 어떤 저장소를 감시하나

- 세션을 연 폴더가 git 저장소 안이면 그 저장소를 감시합니다.
- 저장소가 아닌 폴더(여러 저장소를 모아 둔 폴더 등)에서 세션을 열면, 2단계 아래까지 저장소를 찾습니다. 숨김 폴더와 `node_modules`·`build`·`dist` 등은 건너뜁니다. 이때는 저장소마다 `# Repository: <이름>` 제목이 붙습니다.
  - 찾은 저장소가 30개 이하면 모두 감시합니다.
  - 30개를 넘으면 **AI가 읽거나 수정한 저장소만** 감시합니다. AI가 파일을 읽거나 고치거나 그 저장소에서 명령을 실행하면 감시 대상이 되고, 그 시점 상태를 기준으로 삼습니다. 최근 7일 안에 다룬 저장소는 새 채팅에서도 계속 감시합니다. 깊이와 상관없이 세션 폴더 아래라면 해당됩니다.
- 처음 보는 저장소는 그 시점 상태를 기준으로 삼고, 다음부터 변경을 알려 줍니다.

### 기록 위치

각 저장소의 `.git/offscreen/` 폴더에 저장되므로 커밋에 섞이지 않습니다. 이 폴더를 지우면 기록이 초기화됩니다. 저장소가 많은 폴더에서 최근에 다룬 저장소 목록은 `~/.offscreen/workspaces/`에 저장됩니다.

## 명령

| Claude Code | Codex | 동작 |
|---|---|---|
| `/offscreen:offscreen-show` | 스킬 `offscreen-show` | 아직 전달되지 않은 변경 미리보기 + 최근에 AI에 전달한 내역 |
| `/offscreen:offscreen-reset` | 스킬 `offscreen-reset` | 지금 상태를 새 기준으로 삼기 (지금까지의 변경은 전달하지 않음) |

## 설정

설정 파일은 필요할 때만 만들면 됩니다. 아래 위치 중 앞쪽이 우선합니다.

1. 저장소의 `.claude/offscreen.json` 또는 `.codex/offscreen.json`
2. (상위 폴더에서 세션을 열었을 때) 그 폴더의 `.claude/offscreen.json`
3. 홈의 `~/.claude/offscreen.json` 또는 `~/.codex/offscreen.json`

기본값:

```json
{
  "enabled": true,
  "language": "en",
  "notify": true,
  "untracked": "all",
  "ignore": [],
  "limits": { "maxReflog": 15, "maxCommits": 10, "maxFiles": 30, "maxHashFiles": 500, "maxHashBytes": 8388608, "maxChars": 4000 },
  "workspace": { "mode": "auto", "scanDepth": 2, "maxRepos": 30, "recentDays": 7 }
}
```

| 키 | 설명 |
|---|---|
| `enabled` | `false`면 끕니다. 특정 저장소에서만 끌 때 그 저장소 설정에 넣으세요. |
| `language` | `"en"` 또는 `"ko"` — AI에 전달하는 문구와 알림의 언어 |
| `notify` | 터미널 한 줄 알림 표시 여부 |
| `untracked` | 새 파일 감지 방식. `all`은 새 폴더 안 파일까지 하나하나, `normal`은 폴더 단위. 큰 미추적 폴더가 있으면 `normal` 권장 |
| `ignore` | 보고에서 뺄 경로 패턴. 예: `["dist/**", "*.log"]`. `/`가 없는 패턴은 어느 깊이에서든 일치하고, `/`로 시작하면 저장소 최상위 기준 |
| `limits.maxReflog` / `maxCommits` / `maxFiles` | 항목별로 보여 줄 최대 개수. 넘으면 `…and N more` |
| `limits.maxHashFiles` | 수정된 파일이 이보다 많으면 "추가 수정" 감지를 생략 |
| `limits.maxHashBytes` | 이보다 큰 파일은 내용 대신 크기·수정 시각으로 비교 |
| `limits.maxChars` | AI에 전달하는 글자 수 상한. 넘으면 뒤를 자릅니다 |
| `workspace.mode` | 상위 폴더에서 감시할 저장소. `auto`: 개수가 `maxRepos` 이하면 전부, 넘으면 AI가 다룬 것만 / `all`: 항상 전부(앞에서부터 `maxRepos`개까지) / `active`: 항상 AI가 다룬 것만 |
| `workspace.scanDepth` | 상위 폴더에서 저장소를 찾을 깊이. `0`이면 상위 폴더 세션에서는 동작하지 않음 |
| `workspace.maxRepos` | 모두 감시할 저장소 수의 상한. AI가 다룬 저장소만 감시할 때도 최근 순으로 이 개수까지 |
| `workspace.recentDays` | AI가 다룬 저장소를 며칠 동안 계속 감시할지 |

상위 폴더에서 세션을 열었을 때 `language`·`notify`·`limits.maxChars`·`workspace`는 그 폴더의 설정을 따르고, 나머지는 저장소별 설정이 우선합니다.

## 알아 둘 점

- **AI가 작업하는 도중에 바꾼 내용**: AI가 도구를 실행할 때마다 기준을 새로 잡기 때문에, AI 작업 중에 동시에 바꾼 내용은 알려 주지 못할 수 있습니다.
- **AI가 띄운 백그라운드 작업**: AI가 백그라운드로 실행한 명령이 응답이 끝난 뒤 저장소를 바꾸면, 다음 프롬프트에 "대화 밖 변경"으로 보고됩니다.
- **세션 폴더 밖의 저장소**: AI가 세션 폴더 밖에 있는 저장소를 고치면, 그 변경이 나중에 "대화 밖 변경"으로 보고될 수 있습니다.
- **저장소가 많은 폴더**: 저장소가 30개를 넘는 폴더에서는 AI가 한 번도 다루지 않은 저장소에서 한 작업은 알려 주지 않습니다. AI가 그 저장소에 대해 알고 있는 게 없으니 어긋날 일도 없다고 봅니다. 꼭 알아야 하는 저장소가 있으면 AI에게 그 저장소를 한 번 보게 하세요.
- **속도**: 저장소 하나는 프롬프트마다 0.2초 안팎입니다. 상위 폴더에서 저장소 14개를 모두 감시하면 약 1.5초, 저장소 120개 중 AI가 다룬 몇 개만 감시하면 0.2~0.4초가 더해집니다(Windows 기준). 큰 저장소는 `untracked: "normal"`이나 `ignore`로 줄일 수 있습니다. `git status`가 8초 넘게 걸리면 그 차례는 건너뜁니다.
- **문제 확인**: 오류는 각 저장소의 `.git/offscreen/error.log`에 남습니다.

## License

[Unlicense](LICENSE) — 퍼블릭 도메인. 출처 표기 없이 자유롭게 사용·수정·배포할 수 있습니다.
