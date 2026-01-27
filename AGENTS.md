# Telegram Gateway Agent Instructions

> Inherits from ~/repos/AGENTS.md

## Project Commands

- Build: `npm run build`
- Dev: `npm run dev`
- Test all: `npm test`
- Test single: `npm test -- -t "pattern"`
- Lint: `npm run lint`
- Type-check: `npm run typecheck`

## Project Structure

- `src/daemon/` - CLI entrypoint and daemon lifecycle
- `src/gateway/` - Gateway server, HTTP/WS, Telegram adapter
- `src/protocol/` - Shared protocol types
- `src/client/` - Node client for HTTP/WS
- `src/bridge/` - JSONL bridge for CLI agents (claude, droid)
- `src/cron/` - Scheduled job service
- `adapters/` - CLI adapter manifests (claude.yaml, droid.yaml)
- `tests/` - Unit/integration tests

## Key Files

- `src/gateway/server.ts` - Main gateway server, Telegram bot, HTTP/WS endpoints
- `src/bridge/jsonl-bridge.ts` - CLI agent bridge with typing indicators, session management
- `src/daemon/run.ts` - Daemon startup, restart notifications
- `src/gateway/config.ts` - Configuration loading

## Key Patterns

- ESM Node + TypeScript strict mode
- Prefer explicit types in protocol and gateway boundaries

## Deployment

- **Running on**: Mac Mini (`ssh bens-mac-mini`)
- **Start**: `npm run build && node dist/daemon/cli.js start`
- **Daemon**: `node dist/daemon/cli.js start --daemon`
- **Stop**: `node dist/daemon/cli.js stop`
- **Status**: `node dist/daemon/cli.js status`
- **Config**: `~/.tg-gateway/config.json` or `TG_GATEWAY_CONFIG` env var

## Features

- Telegram typing indicator ("is typing...") during agent work
- Restart notifications to users when gateway restarts
- Disconnect notifications on shutdown
- JSONL bridge for Claude CLI and Droid CLI
- Cron job scheduling for automated messages
- Session resume support per CLI
