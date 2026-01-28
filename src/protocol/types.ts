export const PROTOCOL_VERSION = 1

export type Attachment = {
	type: 'photo' | 'document' | 'voice' | 'audio'
	fileId: string
	duration?: number // seconds for voice/audio
	mimeType?: string
	localPath?: string // Populated after download
}

export type IncomingMessage = {
	id: string
	chatId: number | string
	userId: number | string
	messageId: number
	text?: string
	attachments?: Attachment[]
	timestamp: string
	raw: unknown
}

export type OutboundMessage = {
	chatId: number | string
	text?: string
	photoUrl?: string
	documentUrl?: string
	caption?: string
	replyToMessageId?: number
}

export type TypingRequest = {
	chatId: number | string
}

export type GatewayEvent =
	| { type: 'message.received'; payload: IncomingMessage }
	| { type: 'message.sent'; payload: { chatId: number | string; messageId?: number } }
	| { type: 'error'; payload: { message: string; detail?: string } }

export type SendResponse = {
	ok: boolean
	messageId?: number
	error?: string
}

export type HealthResponse = {
	ok: boolean
	version: number
}

export type StatusResponse = {
	startedAt: string
	uptimeMs: number
	connections: number
	bot?: {
		id: number
		username?: string
		firstName?: string
	}
}
