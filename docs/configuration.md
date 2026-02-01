# Configuration

## Config file

Default path (if `TG_GATEWAY_CONFIG` is not set):

- `~/.config/tg-gateway/config.json`

Example:

```json
{
  "botToken": "TELEGRAM_BOT_TOKEN",
  "host": "127.0.0.1",
  "port": 8787,
  "authToken": "optional-shared-secret",
  "allowedChatIds": [123456789],
  "bridge": {
    "enabled": true,
    "defaultCli": "claude",
    "subagentFallbackCli": "droid",
    "workingDirectory": "/Users/mini/bites",
    "adaptersDir": "/Users/mini/repos/bitesbot/adapters",
    "envFile": "~/.secrets",
    "memory": {
      "enabled": true,
      "workspaceDir": "/Users/mini/bites",
      "qmdPath": "/Users/mini/.bun/bin/qmd",
      "qmdCollection": "bites",
      "qmdIndexPath": "/Users/mini/bites/.state/qmd/index.sqlite",
      "maxResults": 6,
      "minScore": 0.35,
      "links": {
        "enabled": true,
        "maxBacklinks": 2,
        "maxForwardLinks": 2,
        "configDir": "/Users/mini/.config/tg-gateway"
      }
    }
  }
}
```

Notes:

- `botToken` is required.
- `authToken` enables bearer auth on HTTP/WS endpoints.
- `allowedChatIds` filters inbound Telegram updates.
- `bridge.envFile` loads environment variables from a shell-style file (supports `export KEY=value` and `KEY=value`). Useful for passing API keys to CLI adapters (e.g., `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) when running as a launchd service.
- `bridge.memory` is optional; defaults are applied when omitted.

## Environment variables

- `TG_GATEWAY_BOT_TOKEN` (required)
- `TG_GATEWAY_HOST` (default: `127.0.0.1`)
- `TG_GATEWAY_PORT` (default: `8787`)
- `TG_GATEWAY_AUTH_TOKEN` (optional)
- `TG_GATEWAY_ALLOWED_CHAT_IDS` (comma-separated list)
- `TG_GATEWAY_CONFIG` (override config file path)
- `TG_GATEWAY_PID_PATH` (override PID file path)
- `TG_GATEWAY_LOG_DIR` (override internal gateway log directory)

Bridge:

- `TG_GATEWAY_BRIDGE_ENABLED` (`true` to enable)
- `TG_GATEWAY_DEFAULT_CLI` (default: `claude`)
- `TG_GATEWAY_SUBAGENT_FALLBACK_CLI` (optional)
- `TG_GATEWAY_WORKING_DIR` (default: `process.cwd()`)
- `TG_GATEWAY_ADAPTERS_DIR` (default: `./adapters`)
- `TG_GATEWAY_ENV_FILE` (path to shell-style env file, e.g., `~/.secrets`)
- `TG_GATEWAY_CLI_<NAME>_BIN` (override adapter command path, e.g., `TG_GATEWAY_CLI_PI_BIN=/path/to/pi`)
- `TG_GATEWAY_<NAME>_BIN` (legacy alias for the above)

Memory:

- `TG_GATEWAY_MEMORY_ENABLED` (default: `true`)
- `TG_GATEWAY_MEMORY_DIR` (workspace dir; default: bridge working dir)
- `TG_GATEWAY_QMD_PATH` (default: `qmd` or `~/.bun/bin/qmd` if present)
- `TG_GATEWAY_QMD_COLLECTION` (default: `bites`)
- `TG_GATEWAY_QMD_INDEX_PATH` (default: `<workspace>/.state/qmd/index.sqlite`)
- `TG_GATEWAY_MEMORY_MAX_RESULTS` (default: `6`)
- `TG_GATEWAY_MEMORY_MIN_SCORE` (default: `0.35`)
- `TG_GATEWAY_MEMORY_LINKS_ENABLED` (default: `true`)
- `TG_GATEWAY_MEMORY_LINKS_MAX_BACKLINKS` (default: `2`)
- `TG_GATEWAY_MEMORY_LINKS_MAX_FORWARD_LINKS` (default: `2`)
- `TG_GATEWAY_MEMORY_LINKS_CONFIG_DIR` (optional)
