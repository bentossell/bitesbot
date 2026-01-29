# Gateway API

Base URL: `http://<host>:<port>`

If `authToken` is set, include:

```
Authorization: Bearer <token>
```

## HTTP

### GET /health

Response:

```json
{ "ok": true, "version": 1 }
```

### GET /status

Response:

```json
{
  "startedAt": "2026-01-29T12:34:56.000Z",
  "uptimeMs": 123456,
  "connections": 2,
  "bot": {
    "id": 123456,
    "username": "botname",
    "firstName": "Bot"
  }
}
```

### POST /send

Send a message to Telegram.

Request body (`OutboundMessage`):

```json
{
  "chatId": 123456789,
  "text": "hello",
  "photoUrl": "https://...",
  "documentUrl": "https://...",
  "documentPath": "/tmp/report.pdf",
  "documentFilename": "report.pdf",
  "caption": "optional caption",
  "replyToMessageId": 42,
  "inlineButtons": [[{"text":"A","callbackData":"a"}]]
}
```

Response (`SendResponse`):

```json
{ "ok": true, "messageId": 123 }
```

### POST /typing

Request body:

```json
{ "chatId": 123456789 }
```

Response:

```json
{ "ok": true }
```

## WebSocket

### GET /events

Streams `GatewayEvent` payloads:

- `message.received` with `IncomingMessage`
- `message.sent` with `{ chatId, messageId }`
- `callback.query` with `CallbackQuery`
- `error` with `{ message, detail? }`

`IncomingMessage` includes:

```json
{
  "id": "...",
  "chatId": 123456789,
  "userId": 123,
  "messageId": 456,
  "text": "...",
  "attachments": [{ "type": "photo", "fileId": "...", "localPath": "/tmp/.." }],
  "timestamp": "2026-01-29T12:34:56.000Z",
  "forward": { "fromUser": { "id": 1, "username": "..." } },
  "raw": { }
}
```
