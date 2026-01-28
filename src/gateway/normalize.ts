import type { Message } from 'grammy/types'
import type { Attachment, ForwardInfo, IncomingMessage } from '../protocol/types.js'

const resolveForwardInfo = (message: Message): ForwardInfo | undefined => {
	// Check for forward_origin (newer Telegram API) or forward_from (older)
	const raw = message as unknown as Record<string, unknown>
	
	// Handle forward_origin (Telegram Bot API 7.0+)
	if (raw.forward_origin) {
		const origin = raw.forward_origin as Record<string, unknown>
		if (origin.type === 'user' && origin.sender_user) {
			const sender = origin.sender_user as Record<string, unknown>
			return {
				fromUser: {
					id: sender.id as number,
					firstName: sender.first_name as string | undefined,
					lastName: sender.last_name as string | undefined,
					username: sender.username as string | undefined,
				},
				date: origin.date as number | undefined,
			}
		}
		if (origin.type === 'channel' && origin.chat) {
			const chat = origin.chat as Record<string, unknown>
			return {
				fromChat: {
					id: chat.id as number,
					title: chat.title as string | undefined,
					type: chat.type as string | undefined,
				},
				date: origin.date as number | undefined,
			}
		}
		// Hidden user or other origin types
		if (origin.date) {
			return { date: origin.date as number }
		}
	}
	
	// Fallback to older forward_from / forward_from_chat fields
	if (raw.forward_from) {
		const sender = raw.forward_from as Record<string, unknown>
		return {
			fromUser: {
				id: sender.id as number,
				firstName: sender.first_name as string | undefined,
				lastName: sender.last_name as string | undefined,
				username: sender.username as string | undefined,
			},
			date: raw.forward_date as number | undefined,
		}
	}
	
	if (raw.forward_from_chat) {
		const chat = raw.forward_from_chat as Record<string, unknown>
		return {
			fromChat: {
				id: chat.id as number,
				title: chat.title as string | undefined,
				type: chat.type as string | undefined,
			},
			date: raw.forward_date as number | undefined,
		}
	}
	
	return undefined
}

const resolveAttachments = (message: Message): Attachment[] | undefined => {
	const attachments: Attachment[] = []

	if ('photo' in message && message.photo?.length) {
		const largest = message.photo[message.photo.length - 1]
		attachments.push({ type: 'photo', fileId: largest.file_id })
	}

	if ('voice' in message && message.voice) {
		attachments.push({
			type: 'voice',
			fileId: message.voice.file_id,
			duration: message.voice.duration,
			mimeType: message.voice.mime_type,
		})
	}

	if ('audio' in message && message.audio) {
		attachments.push({
			type: 'audio',
			fileId: message.audio.file_id,
			duration: message.audio.duration,
			mimeType: message.audio.mime_type,
		})
	}

	if ('document' in message && message.document) {
		attachments.push({
			type: 'document',
			fileId: message.document.file_id,
			mimeType: message.document.mime_type,
		})
	}

	return attachments.length ? attachments : undefined
}

export const normalizeMessage = (message: Message): IncomingMessage => {
	const attachments = resolveAttachments(message)
	const forward = resolveForwardInfo(message)
	const text = 'text' in message ? message.text : message.caption

	return {
		id: `${message.chat.id}:${message.message_id}`,
		chatId: message.chat.id,
		userId: message.from?.id ?? message.chat.id,
		messageId: message.message_id,
		text: text ?? undefined,
		attachments,
		timestamp: new Date(message.date * 1000).toISOString(),
		forward,
		raw: message,
	}
}
