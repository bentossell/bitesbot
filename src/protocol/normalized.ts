export type NormalizedResponse = {
	schemaVersion: 1
	messageId: string
	conversationId?: string
	transport?: 'telegram' | 'slack' | 'imessage' | string
	transportThreadId?: string
	sessionId?: string
	cli: 'droid' | 'claude' | 'codex' | 'pi' | string
	model?: string
	timestamp: string
	content: ContentBlock[]
	attachments?: Attachment[]
	meta?: {
		costUsd?: number
		usage?: {
			inputTokens?: number
			outputTokens?: number
			totalTokens?: number
		}
		streaming?: boolean
		toolCount?: number
	}
}

export type ContentBlock =
	| { type: 'text'; text: string; format: 'markdown' | 'plain' }
	| { type: 'code'; text: string; language?: string }
	| { type: 'heading'; level: 1 | 2 | 3; text: string }
	| { type: 'list'; style: 'bulleted' | 'numbered'; items: string[] }
	| { type: 'tool_status'; name: string; status: 'start' | 'end' | 'error'; preview?: string; toolId?: string; raw?: unknown }
	| { type: 'status'; text: string }
	| { type: 'error'; text: string }

export type Attachment = {
	kind: 'file' | 'image' | 'audio' | 'voice'
	path: string
	caption?: string
}

export type ConversationKey = {
	conversationId: string
	transport: 'telegram' | 'slack' | 'imessage' | string
	transportThreadId?: string
	userId?: string
}

export type NormalizedDelta = {
	schemaVersion: 1
	messageId: string
	append: ContentBlock[]
}
