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
  chatId: number | string
  text?: string
  editMessageId?: number
  structured?: Record<string, unknown>
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
  messageId?: number
  error?: string
}

export type TypingRequest = {
  chatId: number | string
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
  chatId: number | string
  userId: number | string
  messageId: number
  text?: string
  attachments?: IncomingAttachment[]
  timestamp: string
  source?: "telegram" | "web"
  forward?: {
    fromUser?: {
      id: number
      username?: string
    }
  }
  raw?: Record<string, unknown>
}

export type IngestRequest = {
  id?: string
  chatId: number | string
  userId?: number | string
  text?: string
  timestamp?: string
  source?: "web"
}

export type IngestResponse = {
  ok: boolean
  error?: string
}

export type AgentActivityPayload = {
  chatId: number | string
  activity:
    | { type: "started" }
    | { type: "tool_start"; toolId: string; name: string }
    | { type: "tool_end"; toolId: string; name: string; isError: boolean }
    | { type: "completed" }
}

export type GatewayEvent =
  | { type: "message.received"; payload: IncomingMessage }
  | { type: "message.sent"; payload: { chatId: number | string; messageId?: number } }
  | { type: "message.outbound"; payload: OutboundMessage }
  | { type: "agent.activity"; payload: AgentActivityPayload }
  | { type: "callback.query"; payload: Record<string, unknown> }
  | { type: "error"; payload: { message: string; detail?: string } }
