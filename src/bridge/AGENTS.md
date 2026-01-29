# Bridge notes

> Inherits from ../../AGENTS.md

## Scope

- Connects to gateway events, spawns CLI agents, manages sessions, and handles Telegram commands.

## Entry points

- `src/bridge/jsonl-bridge.ts` - main bridge loop and command parsing
- `src/bridge/jsonl-session.ts` - session lifecycle and JSONL IO
- `src/bridge/manifest.ts` - adapter manifest loading

## Key modules

- `src/bridge/session-store.ts` - session persistence and resume
- `src/bridge/command-queue.ts` - per-chat queues
- `src/bridge/subagent-*.ts` - subagent registry and commands
- `src/bridge/memory-sync.ts` - session -> memory sync

## Gotchas

- Commands like `/new`, `/stop`, `/interrupt`, `/spawn`, `/cron` are handled here.
- Manifests are only loaded if the CLI binary exists on the host.
- Streaming vs non-streaming output is stored in the persistent session store.
