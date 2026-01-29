# Bridge

The bridge connects the gateway WebSocket stream to CLI agents. It manages sessions, queues, subagents, and optional memory/context injection.

## How it works

- Connects to `/events` WebSocket
- On `message.received`, selects a CLI (default or per chat)
- Spawns the CLI using a manifest in `adapters/`
- Streams output back through `/send`
- Sends typing indicators to Telegram during work

## Adapter manifests

Adapter manifests live in `adapters/*.yaml` and define how to spawn each CLI. See `src/bridge/manifest.ts` for the schema.

Key fields:

- `name` - adapter name, used by `/use`
- `command` - CLI binary or path
- `args` - array of fixed args
- `inputMode` - `jsonl`, `stdin`, or `arg`
- `workingDirFlag` - optional flag for working directory
- `resume`, `model`, `specMode` - optional flags for resume/model/spec

## Telegram commands

Session and model:

- `/new` - save memory and start a fresh session
- `/stop` - stop the current session
- `/interrupt` or `/skip` - stop current task, keep queue
- `/status` - session state and settings
- `/use <cli>` - switch adapter (e.g. `claude`, `droid`)
- `/model <alias|id>` - set the model for the next session
- `/stream` or `/stream on|off` - toggle streaming output
- `/verbose` or `/verbose on|off` - toggle tool output
- `/restart` - restart the gateway process

Concepts:

- `/concepts <term>` - list files mentioning a concept
- `/related <term>` - related concepts and files
- `/file <path>` - concepts found in a file
- `/aliases list|add <alias> <canonical>|remove <alias>` - manage concept aliases

Planning and subagents:

- `/spec <task>` - request a plan for approval
- `/spawn ...` - spawn a subagent (see command help)
- `/subagents` - list/stop/log subagents

Cron:

- `/cron list`
- `/cron add "name" every 30m`
- `/cron add "name" cron "0 9 * * *"`
- `/cron remove <id>`
- `/cron run <id>`
- `/cron enable <id>`
- `/cron disable <id>`

## Memory integration

If memory is enabled in config, the bridge can inject recall results into prompts and expose a memory tool. See `src/memory/` for details.
