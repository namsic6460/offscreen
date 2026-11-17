---
name: offscreen-show
description: Show what offscreen has recently reported to the AI about repository changes made outside the conversation, plus any changes not reported yet. Use only when the user asks for it.
disable-model-invocation: true
---

Run the offscreen script in `show` mode and relay its output to the user verbatim (it is already formatted).

The script is `scripts/offscreen.mjs` in this plugin's root, two directories above this SKILL.md file:

- Claude Code: `node "${CLAUDE_SKILL_DIR}/../../scripts/offscreen.mjs" show --cwd "<current working directory>"`
- Otherwise resolve the path relative to this SKILL.md file's directory: `<skill dir>/../../scripts/offscreen.mjs`.

Pass the session's current working directory with `--cwd`. Do not modify the repository. Do not summarize or reinterpret the output beyond translating it if the user writes in another language.
