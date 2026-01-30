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

## Open PRs (12)

| # | Title | Branch |
|---|-------|--------|
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

## Recommended Merge Order (Assume All Today)

1. #23 — Enforced memory recall workflow + boot context
2. #27 — Session management registry/lifecycle
3. #24 — Session tools (history + cross-chat messaging)
4. #25 — Reminder support for cron system
5. #26 — Cron fix: recalculate nextRunAtMs on restart
6. #30 — Agent-to-agent communications
7. #29 — Skills system
8. #28 — Workspace registry (per-agent isolated workspaces)
9. #21 — OpenAI Codex support
10. #22 — Inflection Pi support
11. #31 — E2E test suite (already merged)
12. #20 — Telegram-like web UI (deferred)
13. #8 — Desktop wizard + workspace bootstrap (deferred)

## Per-PR Knockout Steps

1. Review PR diff and relevant files.
2. Discuss and confirm expected behavior and any changes.
3. Implement agreed improvements on the PR branch.
4. Run validators: `pnpm run lint`, `pnpm run typecheck`, `pnpm test`.
5. Push updates and move to the next PR.

## What's Next

### High Priority (Core UX parity with Clawdbot)

1. **Memory system** — Merge enforced memory workflow (#23), wire up QMD search so the bot reliably recalls context across sessions
2. **Session management** — Land session registry + history tools (#27, #24) for proper session lifecycle
3. **Reminders & scheduling** — Merge reminders PR (#25) + cron fix (#26) for proactive bot actions

### Medium Priority

4. **Multi-agent support** — Agent-to-agent comms (#30), skills system (#29), isolated workspaces (#28)
5. **More adapters** — Codex (#21), Pi (#22) for model variety
6. **Testing** — E2E test suite (merged) for confidence in changes

### Lower Priority (Deferred)

- Web UI (#20) — secondary surface, not core focus
- Desktop app wizard (#8) — nice-to-have for onboarding

### Open Questions

- Should `/new` accept a trailing prompt (e.g. "/new, what were we just talking about?") and allow the assistant to recall the just-finished session only on request?

## Launch Goals (Open Source Release)

This will be an open source project anyone can self-host. Before launch, we need:

### Onboarding Experience

The Web UI wizard (#8) and desktop app are **deferred** — not high priority now. But we still need a clear path to get people running bitesbot easily:

- Simple `npx` or `npm install -g` setup
- Minimal config: Telegram bot token + pick a CLI adapter
- Good error messages and `--doctor` diagnostics
- Clear documentation for first-time users

### First-Class Tooling

Since we're a pass-through for CLIs, agents inherit whatever tools their CLI provides. But we want **gateway-managed defaults** for common needs:

- **Browser/web access** — wrap existing `agent-browser` skill behind a gateway tool schema so any CLI can invoke it consistently
- **Web search + fetch** — dedicated tools for uniform UX across adapters
- **Session tools** — `sessions_list`, `sessions_history`, `sessions_send` for cross-session orchestration (already in progress via PRs #24, #27)

This gives users a reliable baseline regardless of which CLI they're using.

### Security (Pre-Launch)

- DM pairing / allowlist for unknown senders
- Exec approval system (ask/allow/deny modes)
- Clear documentation on what access the bot has

## Reference Docs

For deeper comparison with the Clawdbot inspiration project:

- **Core UX Architecture**: `/Users/mini/bites/specs/clawdbot-vs-bitesbot-core-ux-architecture.md` — covers runtime model, system prompt injection, agent-to-agent comms, and pros/cons of pass-through vs embedded runtime
- **Full Feature Comparison**: `/Users/mini/bites/specs/clawdbot-vs-bitesbot-comparison.md` — comprehensive breakdown of all features, gaps, and recommendations

Key insights from those docs:
- Keep the CLI pass-through philosophy (leverage best-in-class coding CLIs without maintaining our own runtime)
- Enforce 3 gateway-level contracts: boot context injection, memory recall workflow, session tools
- Browser automation should be first-class (not just a skill)
- Don't try to match Clawdbot feature-for-feature — focus on simplicity + essential features

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
