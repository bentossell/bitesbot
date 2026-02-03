export type GatewayHealth = {
  ok: boolean
  version: number
}

export type GatewayStatus = {
  startedAt: string
  uptimeMs: number
  connections: number
  bot: {
    id: number
    username: string
    firstName: string
  }
}

export type InlineButton = {
  text: string
  callbackData: string
}

export type OutboundMessage = {
  chatId: number
  text?: string
  photoUrl?: string
  documentUrl?: string
  documentPath?: string
  documentFilename?: string
  caption?: string
  replyToMessageId?: number
  inlineButtons?: InlineButton[][]
}

export type SendResponse = {
  ok: boolean
  messageId: number
}

export type TypingRequest = {
  chatId: number
}

export type TypingResponse = {
  ok: boolean
}

export type IncomingAttachment = {
  type: "photo" | "document" | "audio" | "video" | "file"
  fileId: string
  localPath?: string
}

export type IncomingMessage = {
  id: string
  chatId: number
  userId: number
  messageId: number
  text?: string
  attachments?: IncomingAttachment[]
  timestamp: string
  forward?: {
    fromUser?: {
      id: number
      username?: string
    }
  }
  raw?: Record<string, unknown>
}

export type GatewayEvent =
  | { type: "message.received"; payload: IncomingMessage }
  | { type: "message.sent"; payload: { chatId: number; messageId: number } }
  | { type: "callback.query"; payload: Record<string, unknown> }
  | { type: "error"; payload: { message: string; detail?: string } }
