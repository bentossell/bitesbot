# Protocol notes

> Inherits from ../../AGENTS.md

## Scope

- Shared types between gateway and bridge.

## Entry points

- `src/protocol/types.ts` - events, messages, and protocol version
- `src/protocol/plan-types.ts` - plan approval payloads

## Gotchas

- Bump `PROTOCOL_VERSION` when making breaking changes to event or payload shapes.
