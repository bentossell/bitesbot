import { createReadStream } from 'node:fs'
import type { Bot } from 'grammy'
import type { Message } from 'grammy/types'
import { InputFile } from 'grammy'
import type { Attachment, ContentBlock, NormalizedResponse } from '../protocol/normalized.js'
import { toTelegramMarkdown } from './telegram-markdown.js'

const escapeMarkdownV2 = (text: string): string =>
	text.replace(new RegExp('([_*\\[\\]()~`>#+\\-=|{}.!\\\\])', 'g'), '\\$1')

const renderToolStatus = (block: Extract<ContentBlock, { type: 'tool_status' }>): string => {
	const base = block.status === 'start'
		? `⏳ ${block.name}`
		: block.status === 'end'
			? `✅ ${block.name}`
			: `❌ ${block.name}`
	const preview = block.preview ? ` - ${block.preview}` : ''
	return escapeMarkdownV2(`${base}${preview}`)
}

const renderContentBlock = (block: ContentBlock): string => {
	switch (block.type) {
		case 'text':
			return block.format === 'plain'
				? escapeMarkdownV2(block.text)
				: toTelegramMarkdown(block.text)
		case 'code': {
			const language = block.language ? escapeMarkdownV2(block.language) : ''
			const code = escapeMarkdownV2(block.text)
			return `\`\`\`${language}\n${code}\n\`\`\``
		}
		case 'heading':
			return `*${escapeMarkdownV2(block.text)}*`
		case 'list': {
			return block.items
				.map((item, index) => {
					const prefix = block.style === 'numbered' ? `${index + 1}.` : '•'
					return `${prefix} ${escapeMarkdownV2(item)}`
				})
				.join('\n')
		}
		case 'tool_status':
			return renderToolStatus(block)
		case 'status':
			return escapeMarkdownV2(block.text)
		case 'error':
			return escapeMarkdownV2(`❌ ${block.text}`)
		default:
			return ''
	}
}

export const renderTelegramMarkdown = (response: NormalizedResponse): string => {
	const parts = response.content
		.map((block) => renderContentBlock(block))
		.filter((part) => part.trim().length > 0)
	return parts.join('\n\n')
}

export const splitTelegramMessage = (text: string, maxLength = 4000): string[] => {
	if (text.length <= maxLength) return [text]

	const chunks: string[] = []
	let remaining = text

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining)
			break
		}

		let splitAt = remaining.lastIndexOf('\n', maxLength)
		if (splitAt === -1 || splitAt < maxLength / 2) {
			splitAt = maxLength
		}

		chunks.push(remaining.slice(0, splitAt))
		remaining = remaining.slice(splitAt).trimStart()
	}

	return chunks
}

const sendAttachment = async (bot: Bot, chatId: number | string, attachment: Attachment, caption?: string) => {
	const inputFile = new InputFile(createReadStream(attachment.path), attachment.path.split('/').pop())
	const renderedCaption = caption ? toTelegramMarkdown(caption) : undefined
	if (attachment.kind === 'image') {
		return bot.api.sendPhoto(chatId, inputFile, {
			caption: renderedCaption,
			parse_mode: renderedCaption ? 'MarkdownV2' : undefined,
		})
	}
	if (attachment.kind === 'audio') {
		return bot.api.sendAudio(chatId, inputFile, {
			caption: renderedCaption,
			parse_mode: renderedCaption ? 'MarkdownV2' : undefined,
		})
	}
	if (attachment.kind === 'voice') {
		return bot.api.sendVoice(chatId, inputFile, {
			caption: renderedCaption,
			parse_mode: renderedCaption ? 'MarkdownV2' : undefined,
		})
	}
	return bot.api.sendDocument(chatId, inputFile, {
		caption: renderedCaption,
		parse_mode: renderedCaption ? 'MarkdownV2' : undefined,
	})
}

export const sendNormalizedTelegram = async (
	bot: Bot,
	chatId: number | string,
	response: NormalizedResponse,
	options?: { replyToMessageId?: number; inlineButtons?: Array<Array<{ text: string; callbackData: string }>> },
): Promise<Message> => {
	const replyMarkup = options?.inlineButtons
		? {
			inline_keyboard: options.inlineButtons.map((row) =>
				row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData }))
			),
		}
		: undefined

	const text = renderTelegramMarkdown(response)
	const chunks = text ? splitTelegramMessage(text) : []
	let firstMessage: Message | undefined

	for (let index = 0; index < chunks.length; index += 1) {
		const chunk = chunks[index] ?? ''
		const message = await bot.api.sendMessage(chatId, chunk, {
			reply_to_message_id: index === 0 ? options?.replyToMessageId : undefined,
			parse_mode: 'MarkdownV2',
			reply_markup: index === 0 ? replyMarkup : undefined,
		})
		if (!firstMessage) firstMessage = message
	}

	for (const attachment of response.attachments ?? []) {
		const message = await sendAttachment(bot, chatId, attachment, attachment.caption)
		if (!firstMessage) firstMessage = message
	}

	if (!firstMessage) {
		throw new Error('Structured response produced no content')
	}

	return firstMessage
}
