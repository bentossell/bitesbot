# Telegram Feature Enhancements

Integrating features from openclaw v2026.1.29 into bitesbot.

## Overview

| Feature | Priority | Effort | Status |
|---------|----------|--------|--------|
| Silent sends | High | Small | Planned |
| Message editing | High | Small | Planned |
| Link preview control | Medium | Small | Planned |
| Video note support | Medium | Small | Planned |
| Quote/reply context | Medium | Medium | Planned |
| Sticker support | Low | Medium | — |

## 1. Silent Sends

Send messages without triggering user notifications. Useful for background status updates, cron heartbeats, batch operations.

### Protocol Change
```ts
// protocol/types.ts
export type OutboundMessage = {
  // ... existing fields
  silent?: boolean
}
```

### Server Change
```ts
// gateway/server.ts - in sendOutboundMessage, add to all api calls:
disable_notification: payload.silent,
```

### Use Cases
- Cron job heartbeat messages
- Bulk session updates
- Non-urgent status notifications

---

## 2. Message Editing

Update previously sent messages instead of sending new ones. Useful for progress indicators, live status, correcting errors.

### Protocol Change
```ts
// protocol/types.ts
export type OutboundMessage = {
  // ... existing fields
  editMessageId?: number
}
```

### Server Change
```ts
// gateway/server.ts - at top of sendOutboundMessage:
if (payload.editMessageId) {
  if (payload.photoUrl || payload.documentUrl || payload.documentPath) {
    // Can only edit media caption, not replace media
    return bot.api.editMessageCaption(chatId, payload.editMessageId, {
      caption: payload.caption ?? payload.text ? toTelegramMarkdown(payload.caption ?? payload.text) : undefined,
      parse_mode: 'MarkdownV2',
    })
  }
  return bot.api.editMessageText(chatId, payload.editMessageId, toTelegramMarkdown(payload.text!), {
    parse_mode: 'MarkdownV2',
    reply_markup: reply_markup,
  })
}
```

### Response Change
Track message IDs in bridge for later edits:
```ts
// SendResponse already includes messageId - bridge should store this
```

### Use Cases
- "Thinking..." → actual response
- Progress: "Step 1/3" → "Step 2/3" → "Done"
- Error correction without message spam

---

## 3. Link Preview Control

Disable automatic link preview expansion for cleaner bot responses.

### Protocol Change
```ts
// protocol/types.ts
export type OutboundMessage = {
  // ... existing fields
  disableLinkPreview?: boolean
}
```

### Server Change
```ts
// gateway/server.ts - in sendMessage call:
link_preview_options: payload.disableLinkPreview ? { is_disabled: true } : undefined,
```

### Use Cases
- Responses with many URLs
- Code snippets with URLs
- Cleaner message formatting

---

## 4. Video Note Support

Handle circular video messages (recorded via Telegram's video note feature).

### Protocol Change
```ts
// protocol/types.ts
export type Attachment = {
  type: 'photo' | 'document' | 'voice' | 'audio' | 'video_note'
  // ... existing fields
}
```

### Server Change
```ts
// gateway/normalize.ts - add video_note extraction:
if (msg.video_note) {
  attachments.push({
    type: 'video_note',
    fileId: msg.video_note.file_id,
    duration: msg.video_note.duration,
    mimeType: 'video/mp4',
  })
}
```

### Use Cases
- Accept video note messages from users
- Potential video transcription (future)

---

## 5. Quote/Reply Context

Include quoted message content when user replies to a specific message.

### Protocol Change
```ts
// protocol/types.ts
export type IncomingMessage = {
  // ... existing fields
  replyTo?: {
    messageId: number
    text?: string
    fromUserId?: number
  }
}
```

### Server Change
```ts
// gateway/normalize.ts - extract reply context:
if (msg.reply_to_message) {
  normalized.replyTo = {
    messageId: msg.reply_to_message.message_id,
    text: msg.reply_to_message.text || msg.reply_to_message.caption,
    fromUserId: msg.reply_to_message.from?.id,
  }
}
```

### Use Cases
- Context-aware replies ("regarding what you said about X...")
- Threading conversations
- Reference previous messages in prompts

---

## Implementation Order

1. **Silent sends** - immediate value for cron, minimal change
2. **Message editing** - high UX impact for progress/status
3. **Link preview** - quick win, cleaner output
4. **Video notes** - completeness
5. **Quote context** - richer conversation handling

## Testing Plan

- Unit tests for each protocol type change
- E2E test: send silent message, verify no notification flag
- E2E test: send message, edit it, verify update
- E2E test: send message with link, verify preview disabled
- Manual: send video note, confirm attachment parsed

## References

- [grammy sendMessage docs](https://grammy.dev/ref/core/api#sendMessage)
- [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)
- openclaw CHANGELOG v2026.1.29
