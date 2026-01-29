# Workspace notes

> Inherits from ../../AGENTS.md

## Scope

- Wiki-style link indexing and concept extraction for markdown workspaces.

## Entry points

- `src/workspace/links.ts` - link detection and resolution
- `src/workspace/links-index.ts` - backlinks index manager
- `src/workspace/links-cli.ts` - `tg-links` CLI
- `src/workspace/concepts.ts` - concept extraction
- `src/workspace/concepts-index.ts` - concepts index manager
- `src/workspace/concepts-cli.ts` - `tg-concepts` CLI

## Gotchas

- Config for concepts lives in `~/.config/tg-gateway/concepts.config.json` by default.
- Links index defaults to `~/.config/tg-gateway/links-index.json`.
