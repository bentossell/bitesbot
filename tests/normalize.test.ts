import { describe, expect, it } from 'vitest'
import type { Message } from 'grammy/types'
import { normalizeMessage } from '../src/gateway/normalize.js'

describe('normalizeMessage', () => {
	it('normalizes text messages', () => {
		const message = {
			message_id: 1,
			date: 1_700_000_000,
			chat: { id: 123, type: 'private' },
			from: { id: 456, is_bot: false, first_name: 'Ben' },
			text: 'hello',
		} as unknown as Message

		const normalized = normalizeMessage(message)
		expect(normalized.chatId).toBe(123)
		expect(normalized.userId).toBe(456)
		expect(normalized.text).toBe('hello')
		const attachments = normalized.attachments ?? []
		expect(attachments.length).toBe(0)
	})

	it('captures photo attachments', () => {
		const message = {
			message_id: 2,
			date: 1_700_000_001,
			chat: { id: 789, type: 'private' },
			from: { id: 987, is_bot: false, first_name: 'Ben' },
			photo: [{ file_id: 'small' }, { file_id: 'large' }],
			caption: 'look',
		} as unknown as Message

		const normalized = normalizeMessage(message)
		expect(normalized.text).toBe('look')
		expect(normalized.attachments?.[0]).toEqual({ type: 'photo', fileId: 'large' })
	})
})
