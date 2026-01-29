# Gateway notes

> Inherits from ../../AGENTS.md

## Scope

- Telegram bot, HTTP endpoints, WebSocket events, and message normalization.

## Entry points

- `src/gateway/server.ts` - main server and bot wiring
- `src/gateway/config.ts` - config loading and defaults
- `src/gateway/auth.ts` - bearer auth for HTTP/WS

## Key helpers

- `src/gateway/normalize.ts` - normalize inbound Telegram messages
- `src/gateway/media.ts` - attachment handling and voice transcription
- `src/gateway/telegram-markdown.ts` - MarkdownV2 escaping

## Gotchas

- Default port is 8787 (avoid 7777).
- Attachments can be downloaded to a temp dir; cleanups run on a timer.
- `allowedChatIds` filters inbound updates.
