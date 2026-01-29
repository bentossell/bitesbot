# Adapter notes

> Inherits from ../AGENTS.md

## Scope

- CLI adapter manifests used by the bridge.

## Files

- `adapters/claude.yaml`
- `adapters/droid.yaml`

## Gotchas

- Manifests are only loaded if the CLI binary is present on the host.
- Schema lives in `src/bridge/manifest.ts`.
