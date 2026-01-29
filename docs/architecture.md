# Architecture

## Components

- Gateway server (`src/gateway/`)
  - Telegram bot via grammy
  - HTTP endpoints for health, status, typing, and send
  - WebSocket endpoint for event streaming
  - Normalizes inbound Telegram messages into `IncomingMessage`
- Bridge (`src/bridge/`)
  - Connects to the gateway WebSocket
  - Spawns CLI agents using JSONL or stdin/arg modes
  - Manages sessions, queues, and subagents
  - Provides Telegram slash commands
- Daemon (`src/daemon/`)
  - CLI entrypoint and lifecycle (start/stop/status)
  - Writes PID file and handles shutdown
- Cron (`src/cron/`)
  - Scheduled jobs triggered by Telegram commands
- Protocol (`src/protocol/`)
  - Shared gateway/bridge types and version
- Memory + workspace (`src/memory/`, `src/workspace/`)
  - Recall based on qmd search
  - Links and concepts indexes for workspace markdown

## Data flow

1) Telegram message arrives at the bot (`src/gateway/server.ts`).
2) Message is normalized and broadcast over WebSocket (`/events`).
3) Bridge receives the event, routes it to a CLI session, and streams output.
4) Bridge sends responses to the gateway via HTTP `/send`.
5) Gateway sends the message to Telegram and broadcasts `message.sent`.

## Files to start with

- `src/gateway/server.ts` - main HTTP/WS server and Telegram bot
- `src/bridge/jsonl-bridge.ts` - bridge loop, commands, and session handling
- `src/daemon/cli.ts` - command line entrypoint
- `src/protocol/types.ts` - shared types and event schemas
