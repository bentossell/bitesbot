# tg-gateway (bitesbot)

Portable Telegram gateway for CLI agents. Runs a Telegram bot, exposes HTTP and WebSocket endpoints, and optionally bridges to local CLI agents via JSONL.

## Quickstart

1) Install dependencies:

```bash
npm install
```

2) Configure the gateway (see `docs/configuration.md`). At minimum set:

- `TG_GATEWAY_BOT_TOKEN`

3) Build and run:

```bash
npm run build
npm run gateway:daemon
```

4) Verify:

```bash
curl http://localhost:8787/health
```

## Commands

- `npm run dev` - run the daemon in watch mode
- `npm run gateway` - run the built gateway in the foreground
- `npm run gateway:daemon` - run the gateway as a daemon
- `npm run gateway:status` - check daemon status
- `npm run gateway:stop` - stop the daemon
- `npm run gateway:restart` - restart the daemon

## CLI tools

- `tg-gateway` - daemon entrypoint (built output)
- `tg-links` - workspace wiki-style links index
- `tg-concepts` - workspace concept index

See `docs/workspace-tools.md` and `README-LINKS.md` for details.

## Documentation

- `docs/architecture.md` - system overview and data flow
- `docs/configuration.md` - config file and environment variables
- `docs/gateway-api.md` - HTTP and WebSocket API
- `docs/bridge.md` - JSONL bridge and Telegram commands
- `docs/ops.md` - deployment notes and troubleshooting
- `docs/workspace-tools.md` - links and concepts indexes

## Repository layout

- `src/gateway/` - Telegram bot, HTTP/WS server
- `src/bridge/` - JSONL bridge, session management, subagents
- `src/daemon/` - CLI entrypoint and daemon lifecycle
- `src/cron/` - scheduled job service
- `src/protocol/` - shared protocol types
- `src/memory/` - memory recall tooling
- `src/workspace/` - links and concepts indexes
- `adapters/` - CLI adapter manifests
- `tests/` - unit and integration tests
