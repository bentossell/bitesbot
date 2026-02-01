# Test Gateway Runbook (Manual)

This runbook starts a **test** Telegram gateway on a non-prod port (not 8787), using the test bot from `.env.e2e`.

## Preconditions

- You have `.env.e2e` with valid `TG_E2E_*` values.
- You are in the repo root: `/Users/mini/repos/bitesbot`.
- **Prod** gateway uses port **8787**. Use a different port for test (default in `.env.e2e` is 8790).

## Start Test Gateway (Foreground)

```bash
set -a; source ./.env.e2e; set +a

TG_GATEWAY_CONFIG=/dev/null \
TG_GATEWAY_BOT_TOKEN="$TG_E2E_BOT_TOKEN" \
TG_GATEWAY_PORT="$TG_E2E_GATEWAY_PORT" \
TG_GATEWAY_ALLOWED_CHAT_IDS="$TG_E2E_ALLOWED_CHAT_ID" \
TG_GATEWAY_AUTH_TOKEN="$TG_E2E_AUTH_TOKEN" \
TG_GATEWAY_BRIDGE_ENABLED=true \
TG_GATEWAY_DEFAULT_CLI=pi \
TG_GATEWAY_WORKING_DIR="/Users/mini/repos/bitesbot" \
TG_GATEWAY_ADAPTERS_DIR="/Users/mini/repos/bitesbot/adapters" \
TG_GATEWAY_MEMORY_ENABLED=false \
pnpm run gateway
```

Notes:
- `TG_GATEWAY_CONFIG=/dev/null` prevents picking up prod config.
- Foreground run shows live logs in the terminal.

## Start Test Gateway (Background + Logs)

```bash
set -a; source ./.env.e2e; set +a

TG_GATEWAY_CONFIG=/dev/null \
TG_GATEWAY_BOT_TOKEN="$TG_E2E_BOT_TOKEN" \
TG_GATEWAY_PORT="$TG_E2E_GATEWAY_PORT" \
TG_GATEWAY_ALLOWED_CHAT_IDS="$TG_E2E_ALLOWED_CHAT_ID" \
TG_GATEWAY_AUTH_TOKEN="$TG_E2E_AUTH_TOKEN" \
TG_GATEWAY_BRIDGE_ENABLED=true \
TG_GATEWAY_DEFAULT_CLI=pi \
TG_GATEWAY_WORKING_DIR="/Users/mini/repos/bitesbot" \
TG_GATEWAY_ADAPTERS_DIR="/Users/mini/repos/bitesbot/adapters" \
TG_GATEWAY_MEMORY_ENABLED=false \
nohup pnpm run gateway > ~/logs/bitesbot-test.log 2>&1 &
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
- Background: `~/logs/bitesbot-test.log`
- Gateway file log (errors only): `~/.config/tg-gateway/logs/gateway.log`

## Stop Test Gateway

```bash
pnpm run gateway:stop
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
