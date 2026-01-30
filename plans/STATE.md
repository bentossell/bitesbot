# State of the Project

> Last updated: 2026-01-30

## Vision

Build a simpler, more accessible alternative to Clawdbot — a Telegram bot that lets anyone (including less technical people) work with AI agents effectively. The core experience should match Clawdbot's capabilities: task execution, memory, session management, and natural conversation flow — even if the implementation differs.

We're focusing on the core bot UX first, not expanding to other app surfaces yet.

## What We're Building

**bitesbot** is a portable Telegram gateway for CLI agents. It:

- Runs a Telegram bot with HTTP/WebSocket endpoints
- Bridges to local CLI agents (Claude, Droid, Codex, Pi) via JSONL
- Manages sessions, memory, and workspace context
- Supports cron/scheduled jobs and reminders
- Provides slash commands for model switching, session control, etc.
- **Tool access** — Agents have full filesystem, shell, and web access to complete real tasks
- **Self-improving** — The bot can edit its own code, add features, and redeploy itself

## Current State

### Core Infrastructure ✅
- Gateway server (Telegram + HTTP/WS)
- JSONL bridge for CLI agents
- Daemon lifecycle (start/stop/restart)
- Session management with resume support
- Typing indicators and restart notifications
- Cron job scheduling

### Adapters
- **Claude CLI** — working
- **Droid CLI** — working
- **Codex** — PR open (#21)
- **Pi (Inflection)** — PR open (#22)

### Memory & Context
- QMD-based semantic search (planned, not fully wired)
- Workspace links/concepts indexing
- MEMORY.md native agent writes

## Open PRs (13)

| # | Title | Branch |
|---|-------|--------|
| 31 | E2E test suite for all agent adapters | `feat/agent-e2e-testing` |
| 30 | Agent-to-Agent Communications | `feat/agent-comms-final` |
| 29 | Skills system for loading/managing agent skills | `feat/skills-system` |
| 28 | Workspace registry for per-agent isolated workspaces | `feat/agent-workspaces-final` |
| 27 | Session Management - Registry, Lifecycle & History Tools | `feat/session-management-v2` |
| 26 | Cron: recalculate nextRunAtMs on restart | `fix/cron-recalculate-on-restart` |
| 25 | Reminder support for cron system | `feat/reminders` |
| 24 | Session tools for history + cross-chat messaging | `feat/session-tools` |
| 23 | Enforced memory recall workflow + boot context | `feat/enforced-memory-workflow` |
| 22 | Inflection Pi support | `feat/pi-support` |
| 21 | OpenAI Codex support | `feat/codex-support` |
| 20 | Telegram-like web UI | `claude/telegram-bot-web-ui-n51Rr` |
| 8 | Desktop wizard and workspace bootstrap | `feat/desktop-app-ui-wizard` |

## What's Next

### High Priority (Core UX parity with Clawdbot)

1. **Memory system** — Merge enforced memory workflow (#23), wire up QMD search so the bot reliably recalls context across sessions
2. **Session management** — Land session registry + history tools (#27, #24) for proper session lifecycle
3. **Reminders & scheduling** — Merge reminders PR (#25) + cron fix (#26) for proactive bot actions

### Medium Priority

4. **Multi-agent support** — Agent-to-agent comms (#30), skills system (#29), isolated workspaces (#28)
5. **More adapters** — Codex (#21), Pi (#22) for model variety
6. **Testing** — E2E test suite (#31) for confidence in changes

### Lower Priority (Deferred)

- Web UI (#20) — secondary surface, not core focus
- Desktop app wizard (#8) — nice-to-have for onboarding

## Key Files

- `src/gateway/server.ts` — Telegram bot, HTTP/WS server
- `src/bridge/jsonl-bridge.ts` — CLI agent bridge, commands, sessions
- `src/cron/service.ts` — Scheduled jobs
- `adapters/*.yaml` — CLI adapter manifests

## Running Locally

```bash
pnpm install
pnpm run build
pnpm run gateway:daemon
curl http://localhost:8787/health
```

## Deployment

- Runs on Mac Mini (`ssh bens-mac-mini`)
- Port 8787, launchd service `com.bentossell.bitesbot`
- Logs: `~/logs/bitesbot.log`
