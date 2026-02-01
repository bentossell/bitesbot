# Test Gateway Runbook (Manual)

This runbook starts a **test** Telegram gateway on a non-prod port (not 8787), using the test bot from `.env.e2e`.

## Preconditions

- You have `.env.e2e` with valid `TG_E2E_*` values.
- You are in the repo root: `/Users/mini/repos/bitesbot`.
- **Prod** gateway uses port **8787**. Use a different port for test (default in `.env.e2e` is 8790).
- The test scripts default to port **8788** if `TG_E2E_GATEWAY_PORT` is not set.

## Start Test Gateway (Foreground)

```bash
pnpm run gateway:test
```

Notes:
- `TG_GATEWAY_CONFIG=/dev/null` prevents picking up prod config.
- Foreground run shows live logs in the terminal.
- Set `TG_GATEWAY_TEST_BUILD=0` to skip rebuilds.

## Convenience commands

```bash
pnpm run gateway:test
pnpm run gateway:test:status
pnpm run gateway:test:logs
pnpm run gateway:test:stop
```

## Start Test Gateway (Background + Logs)

```bash
pnpm run gateway:test:restart
```

## Health Checks

```bash
curl http://127.0.0.1:$TG_E2E_GATEWAY_PORT/health
curl http://127.0.0.1:$TG_E2E_GATEWAY_PORT/status
```

Expected `/health` response:

```json
{"ok":true,"version":1}
```

## Manual Telegram Test Flow

In Telegram (test bot from `.env.e2e`):

- `/use pi`
- `/status`
- Prompt that should trigger a tool call, e.g.:
  - `create a tmp test file` (if tools are wired)
  - or any known tool-specific prompt for Pi

## Logs

- Foreground: terminal output.
- Background: `~/logs/bitesbot-test.log` (stdout/stderr) + `~/.config/tg-gateway-test/logs/gateway.log` (internal)
- Gateway file log (errors only): `~/.config/tg-gateway/logs/gateway.log`

## Stop Test Gateway

```bash
pnpm run gateway:test:stop
```

## Launchd (Optional)

Install a dedicated test launchd service (auto-restarts on crash):

```bash
pnpm run gateway:test:launchd:install
```

Status / restart / uninstall:

```bash
pnpm run gateway:test:launchd:status
pnpm run gateway:test:launchd:restart
pnpm run gateway:test:launchd:uninstall
```

If multiple gateways are running, identify the test port and stop that PID:

```bash
lsof -nP -iTCP:$TG_E2E_GATEWAY_PORT -sTCP:LISTEN
kill <PID>
```

## Troubleshooting

- **Port in use**: ensure test port is not 8787 and not already bound.
- **Bot not responding**: confirm `TG_E2E_BOT_TOKEN` and `TG_E2E_ALLOWED_CHAT_ID`.
- **No tool calls**: Pi may not be emitting tool events; check logs in `~/logs/bitesbot-test.log`.
- **Prod not affected**: confirm prod gateway still on 8787 (launchd `com.bentossell.bitesbot`).
