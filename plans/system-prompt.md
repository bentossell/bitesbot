# System Prompt Plan

- add prompt builder `src/bridge/system-prompt.ts` (full/minimal)
- extend `CLIManifest` with `systemPromptArg` + `systemPromptWhen` (default first)
- adapters: set arg for CLIs that support it (claude `--append-system-prompt`; droid/pi verify)
- `JsonlSession.run`: inject on new session only; skip resume; subagent uses minimal
- tests: manifest parse; inject only on new; prompt builder snapshot
- docs: `docs/bridge.md` mention system prompt flow
