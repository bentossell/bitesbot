# Cron notes

> Inherits from ../../AGENTS.md

## Scope

- Scheduled job service used by `/cron` commands in the bridge.

## Entry points

- `src/cron/service.ts` - job management API
- `src/cron/scheduler.ts` - timer and scheduling loop
- `src/cron/store.ts` - persistence
- `src/cron/run-history.ts` - run tracking
- `src/cron/types.ts` - shared types
