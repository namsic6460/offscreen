---
name: offscreen-reset
description: Reset offscreen's baseline snapshot to the current repository state so earlier outside changes are no longer reported. Use only when the user asks for it.
disable-model-invocation: true
---

Run the offscreen script in `reset` mode and tell the user the one-line result.

The script is `scripts/offscreen.mjs` in this plugin's root, two directories above this SKILL.md file:

- Claude Code: `node "${CLAUDE_SKILL_DIR}/../../scripts/offscreen.mjs" reset --cwd "<current working directory>"`
- Otherwise resolve the path relative to this SKILL.md file's directory: `<skill dir>/../../scripts/offscreen.mjs`.

Pass the session's current working directory with `--cwd`. Do not modify the repository in any other way.
