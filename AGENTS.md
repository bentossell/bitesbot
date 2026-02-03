# AGENTS.md — bitesbot (tg-gateway)

Portable Telegram gateway for CLI agents. Bridges Telegram messages to Claude, Droid, or other CLI-based agents via JSONL protocol.

## Quick Reference

```bash
# Dev
pnpm dev                          # Start gateway in watch mode
pnpm dev:once                     # Start once (no watch)

# Build  
pnpm build                        # Compile TypeScript

# Test
pnpm test                         # Run all tests
pnpm test:unit                    # Unit tests only (fast)
pnpm test:e2e                     # E2E tests (needs config)
pnpm test -- -t "pattern"         # Run specific test

# Lint/Format
pnpm lint                         # ESLint check
pnpm typecheck                    # TypeScript check

# Gateway (production)
pnpm gateway                      # Run in foreground
pnpm gateway:daemon               # Run as background daemon
pnpm gateway:stop                 # Stop daemon
pnpm gateway:status               # Check if running
pnpm gateway:restart              # Restart daemon
pnpm gateway:restart:build        # Build + restart

# Gateway (launchd service)
pnpm gateway:launchd:start        # Load launchd service
pnpm gateway:launchd:stop         # Unload service
pnpm gateway:launchd:status       # Check service status
pnpm gateway:launchd:restart      # Restart service

# Test gateway (separate instance)
pnpm gateway:test                 # Start test gateway (port 8788)
pnpm gateway:test:stop            # Stop test gateway

# Health
curl http://localhost:8787/health # Check if gateway is up
curl http://localhost:8787/status # Full status info
```

## Stack

- **Language:** TypeScript (ESM, strict mode)
- **Runtime:** Node 22+
- **Package manager:** pnpm
- **Framework:** grammy (Telegram), ws (WebSocket)
- **Testing:** Vitest
- **Linting:** ESLint + TypeScript

## URLs

| Environment | URL | Notes |
|-------------|-----|-------|
| Production | http://localhost:8787 | Default gateway port |
| Test | http://localhost:8788 | Test gateway instance |
| Health | /health | Returns `{"status":"ok"}` |
| Status | /status | Full gateway status |

## Project Structure

```
src/
├── daemon/           # CLI entrypoint, daemon lifecycle
│   ├── cli.ts        # Commander CLI (start/stop/status)
│   └── run.ts        # Daemon startup logic
├── gateway/          # Gateway server
│   ├── server.ts     # Main server, Telegram bot, HTTP/WS
│   ├── config.ts     # Configuration loading
│   └── telegram.ts   # Telegram message handling
├── bridge/           # CLI agent bridge
│   ├── jsonl-bridge.ts    # Main bridge, typing indicators
│   ├── session-manager.ts # Session lifecycle
│   └── adapters/     # CLI adapters (claude, droid, pi)
├── protocol/         # Shared types
├── client/           # HTTP/WS client for testing
├── cron/             # Scheduled jobs service
├── memory/           # Memory/recall integration
├── skills/           # Built-in skills
└── workspace/        # Workspace tools (links, concepts)

adapters/             # CLI adapter manifests
├── claude.yaml
├── droid.yaml
└── pi.yaml

tests/                # Unit + E2E tests
├── *.test.ts         # Unit tests
└── *.e2e.ts          # E2E tests

docs/                 # Documentation
├── architecture.md   # System design
├── bridge.md         # Bridge protocol
├── configuration.md  # Config reference
├── gateway-api.md    # HTTP/WS API
└── ops.md            # Operations guide

scripts/              # Utility scripts
├── gateway-test.sh   # Test gateway management
└── telegram-session.ts # Telegram auth helper

deploy/               # Deployment configs
├── launchd.plist.template
└── setup-launchd.sh
```

## Key Files

| File | When to Read |
|------|--------------|
| `src/gateway/server.ts` | Main server logic, HTTP/WS/Telegram |
| `src/bridge/jsonl-bridge.ts` | CLI agent communication |
| `src/daemon/cli.ts` | CLI commands |
| `docs/configuration.md` | Config file format |
| `docs/ops.md` | Running in production |
| `adapters/*.yaml` | CLI adapter definitions |

## Configuration

Config file: `~/.config/tg-gateway/config.json`

```json
{
  "botToken": "TELEGRAM_BOT_TOKEN",
  "host": "127.0.0.1",
  "port": 8787,
  "authToken": "optional-shared-secret",
  "allowedChatIds": [123456789],
  "bridge": {
    "enabled": true,
    "defaultCli": "claude"
  }
}
```

See `docs/configuration.md` for full reference.

**Environment variables:**
- `TG_GATEWAY_BOT_TOKEN` — Required
- `TG_GATEWAY_PORT` — Default: 8787
- `TG_GATEWAY_CONFIG` — Override config path

## Conventions

- **Commits:** Conventional commits (`feat:`, `fix:`, `docs:`)
- **Types:** Explicit types at protocol/gateway boundaries
- **Tests:** Colocated `*.test.ts`, E2E as `*.e2e.ts`
- **Pre-commit:** `pnpm precommit` (typecheck + lint + test:unit)

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Port already in use | Old process or launchd respawning | `lsof -ti :8787 \| xargs kill -9` |
| Gateway won't start | Missing bot token | Check config or `TG_GATEWAY_BOT_TOKEN` |
| Tests fail | Missing `.env.e2e` | Copy from template, fill in values |
| Launchd keeps restarting | KeepAlive + crash | Check `~/logs/bitesbot.err` |

## Agent Notes

- Run `pnpm precommit` before any PR
- Don't edit `dist/` — it's generated
- For E2E tests, need `.env.e2e` with Telegram credentials
- Logs: `~/logs/bitesbot.log` and `~/logs/bitesbot.err`
