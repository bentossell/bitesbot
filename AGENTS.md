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
- `tests/` - Unit/integration tests

## Key Patterns

- ESM Node + TypeScript strict mode
- Prefer explicit types in protocol and gateway boundaries
