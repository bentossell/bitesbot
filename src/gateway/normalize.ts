import type { Message } from 'grammy/types'
import type { Attachment, IncomingMessage } from '../protocol/types.js'

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
	const text = 'text' in message ? message.text : message.caption

	return {
		id: `${message.chat.id}:${message.message_id}`,
		chatId: message.chat.id,
		userId: message.from?.id ?? message.chat.id,
		messageId: message.message_id,
		text: text ?? undefined,
		attachments,
		timestamp: new Date(message.date * 1000).toISOString(),
		raw: message,
	}
}
