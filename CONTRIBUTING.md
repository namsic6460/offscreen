# offscreen 개발 안내

사용 방법은 [README](README.md)를 보세요. 이 문서는 플러그인을 고치거나 확장하려는 사람을 위한 것입니다.

## 구조

```
.claude-plugin/marketplace.json     Claude Code 마켓플레이스
.agents/plugins/marketplace.json    Codex 마켓플레이스
plugins/offscreen/
  .claude-plugin/plugin.json        Claude Code 매니페스트
  .codex-plugin/plugin.json         Codex 매니페스트 (hooks/hooks.json을 기본으로 사용)
  hooks/hooks.json                  Claude Code·Codex 공용 훅
  skills/offscreen-show, skills/offscreen-reset
  scripts/offscreen.mjs             진입점: save | diff | show | reset
  scripts/lib/{git,store,config,format,glob,workspace,active}.mjs
  scripts/trackers/git.mjs
test/                               node:test
```

## 동작

```
[AI 턴]        PostToolUse (Bash/PowerShell/Edit/Write/MultiEdit/NotebookEdit/apply_patch/mcp__*) → save (async)
               Stop                                                                              → save
[사용자 작업]   아무것도 실행되지 않음
[프롬프트 제출] UserPromptSubmit → diff → 변경이 있으면 additionalContext로 주입 → 즉시 save
```

- 감시 루트: `--cwd` > `CLAUDE_PROJECT_DIR` > 훅 입력의 `cwd` > `process.cwd()`. 루트가 저장소 안이면 그 저장소(single), 아니면 하위 저장소를 찾습니다(`lib/workspace.mjs`).
  - `all`: 찾은 저장소가 `workspace.maxRepos` 이하(또는 `mode: "all"`)면 전부.
  - `active`: 그보다 많으면 최근에 쓴 저장소만(`lib/active.mjs`). 도구 훅 입력(`cwd`, `tool_input`의 경로·명령 토큰·`apply_patch` 헤더)에서 위로 올라가며 `.git`을 찾아 루트 아래 저장소를 모으고, `~/.offscreen/workspaces/<sha1(root)>.json`에 마지막 사용 시각을 남깁니다. `recentDays` 안의 저장소를 최근 순으로 `maxRepos`개까지 감시합니다.
  - 읽기 도구(Read/Grep/Glob/LS/NotebookRead)는 active 모드에서만 의미가 있습니다. 이번 세션 스냅샷이 없는 저장소의 기준만 저장하고, 다른 모드에서는 바로 끝납니다.
- 스냅샷: `<git-dir>/offscreen/`
  - `sessions/<session_id>.json` — 세션별 기준 (7일 지나면 정리)
  - `snapshot.json` — 마지막 기준. 새 세션은 여기서 시작
  - `history.jsonl` — AI에 전달한 내역 (최근 50개)
  - `error.log`
- 저장은 tmp 파일 → rename으로 원자적으로 합니다. `takenAtMs`가 더 최신인 스냅샷은 덮어쓰지 않습니다(백그라운드 저장 순서 보호).
- reflog는 저장 시점의 최상단 항목을 마커로 기억해 그 위 항목만 보여 줍니다. 마커가 없으면 시각으로 거릅니다.
- git은 `GIT_OPTIONAL_LOCKS=0`으로 실행해 사용자의 git 작업과 `index.lock`을 다투지 않습니다. 셸을 거치지 않습니다(`execFile`).
- 어떤 경우에도 exit 0으로 끝나고, 9초 안에 스스로 종료합니다(훅 timeout 10초).

## 테스트

```bash
npm test
```

```bash
claude plugin validate .
```

`npm test`는 임시 디렉터리에 git 저장소를 만들고 실제 git 명령으로 시나리오를 검증합니다.

## tracker 추가

`plugins/offscreen/scripts/trackers/<name>.mjs`에 아래 형태의 모듈을 만들고 `scripts/offscreen.mjs`의 `TRACKERS`에 등록한 뒤, 설정의 `trackers` 배열에 이름을 넣습니다(기본값 `["git"]`).

```js
export default {
  name: 'docker',
  async snapshot(ctx) { /* 직렬화 가능한 현재 상태, 해당 없으면 null */ },  // ctx = { cwd, top, gitDir, config, t }
  async diff(prev, cur, ctx) { return [{ title: 'Containers', lines: ['+ web (up)'], summary: 'docker' }]; },
};
```

## 릴리스

- `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`의 `version`을 함께 올립니다. Codex는 버전별 폴더에 설치하므로 버전이 같으면 업데이트가 반영되지 않을 수 있습니다.
- 로컬에서 시험할 때: Claude Code는 `claude --plugin-dir ./plugins/offscreen`, Codex는 `codex plugin marketplace add <이 저장소 경로>` 후 `codex plugin add offscreen@offscreen`.

## Codex 훅 신뢰 (0.169 기준)

Codex는 `~/.codex/config.toml`의 `[hooks.state."offscreen@offscreen:hooks/hooks.json:<event>:0:0"]`에 훅 정의 해시(`trusted_hash`)와 플러그인 내용 해시(`trusted_content_hash`)를 둘 다 기록하고, 현재 값과 다르면 상태를 `modified`로 보고 훅을 건너뜁니다. 설치된 플러그인 파일(`~/.codex/plugins/cache/...`)을 직접 고치면 내용 해시가 바뀌어 훅이 멈춥니다. 훅 상태는 `codex app-server`에 `hooks/list`(params `{}`)를 보내 `trustStatus`로 확인할 수 있습니다.
