# Session Memory + Model Switching

## Model Switching

Slash commands:
- `/models` - show current model + available aliases
- `/model <alias>` - switch model (clears session)

Aliases (both CLIs):
- `opus` -> claude-opus-4-5-20251101
- `sonnet` -> claude-sonnet-4-5-20250929  
- `haiku` -> claude-haiku-4-5-20251001
- `codex` -> gpt-5.2-codex (droid only)

Reasoning combos (droid only): `sonnet-high`, `codex-medium`, etc.

## Memory (QMD)

Agent writes to `MEMORY.md` in workspace (native behavior).
QMD indexes workspace for semantic search.

### Setup
```bash
bun install -g https://github.com/tobi/qmd
qmd collection add ~/bites --name tg-workspace
qmd embed
```

### Status
- [x] Model switching implemented
- [x] Adapters updated with systemPromptPrefix
- [ ] Install QMD
- [ ] Create collection + embed
