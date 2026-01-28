# Telegram Gateway Agent Instructions

> Inherits from ~/repos/AGENTS.md

## Project Commands

- Build: `npm run build`
- Dev: `npm run dev`
- Test all: `npm test`
- Test single: `npm test -- -t "pattern"`
- Lint: `npm run lint`
- Type-check: `npm run typecheck`

## Gateway Commands

- `npm run gateway` - Run gateway in foreground
- `npm run gateway:daemon` - Run gateway as background daemon
- `npm run gateway:stop` - Stop the daemon
- `npm run gateway:status` - Check daemon status
- `npm run gateway:restart` - Stop and restart daemon

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
- **Default port**: 8787 (NOT 7777)
- **Health check**: `curl http://localhost:8787/health`
- **Status endpoint**: `curl http://localhost:8787/status`
- **Config**: `~/.tg-gateway/config.json` or `TG_GATEWAY_CONFIG` env var
- **Launchd service**: `com.bentossell.bitesbot` (auto-restarts on crash)
- **Logs**: `~/logs/bitesbot.log` and `~/logs/bitesbot.err`

## Port Conflicts (EADDRINUSE)

If gateway fails to start with `EADDRINUSE` on port 8787:

1. **Check what's using the port**:
   ```bash
   lsof -i :8787
   ```

2. **If launchd is respawning (KeepAlive=true)**:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.bentossell.bitesbot.plist
   sleep 3  # Wait for port release
   launchctl load ~/Library/LaunchAgents/com.bentossell.bitesbot.plist
   ```

3. **If zombie processes**:
   ```bash
   lsof -ti :8787 | xargs kill -9
   ```

4. **Verify gateway is running**:
   ```bash
   curl http://localhost:8787/health
   # Should return: {"ok":true,"version":1}
   ```

## Features

- Telegram typing indicator ("is typing...") during agent work
- Restart notifications to users when gateway restarts
- Disconnect notifications on shutdown
- JSONL bridge for Claude CLI and Droid CLI
- Cron job scheduling for automated messages
- Session resume support per CLI
