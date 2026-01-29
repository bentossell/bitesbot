# Memory notes

> Inherits from ../../AGENTS.md

## Scope

- qmd-based recall and memory tool plumbing for the bridge.

## Entry points

- `src/memory/recall.ts` - recall building and formatting
- `src/memory/tools.ts` - memory tool request/response handling
- `src/memory/qmd-client.ts` - qmd invocation
- `src/memory/types.ts` - memory config types

## Gotchas

- Recall optionally decorates results with links from `src/workspace/links-index.ts`.
- qmd paths and indexes are configured via gateway config.
