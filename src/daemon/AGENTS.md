# Daemon notes

> Inherits from ../../AGENTS.md

## Scope

- CLI entrypoint and daemon lifecycle: start/stop/status.

## Entry points

- `src/daemon/cli.ts` - CLI command routing
- `src/daemon/run.ts` - startup sequence (gateway first, then bridge)
- `src/daemon/pid.ts` - pid file handling

## Gotchas

- Gateway must start before the bridge so the bridge can connect.
- Shutdown handler terminates bridge, closes server, and clears pid file.
