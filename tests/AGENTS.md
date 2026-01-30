# Tests notes

> Inherits from ../AGENTS.md

## Scope

- Unit, integration, and e2e coverage for gateway and bridge.

## Commands

- `pnpm test` - full suite
- `pnpm run test:unit` - unit only
- `pnpm run test:e2e` - e2e only

## Gotchas

- E2E tests use `vitest.e2e.config.ts`.
- E2E is local-only and requires `TG_E2E_RUN=1` plus `TG_E2E_API_ID`, `TG_E2E_API_HASH`, `TG_E2E_SESSION`, `TG_E2E_BOT_TOKEN`, `TG_E2E_BOT_USERNAME` (optionals: `TG_E2E_AUTH_TOKEN`, `TG_E2E_ALLOWED_CHAT_ID`, `TG_E2E_GATEWAY_PORT`).
