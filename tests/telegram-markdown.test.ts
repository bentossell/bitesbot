import { describe, it, expect } from 'vitest'
import { toTelegramMarkdown } from '../src/gateway/telegram-markdown.js'

describe('toTelegramMarkdown', () => {
	it('escapes MarkdownV2 reserved characters', () => {
		const input = 'Name (test) [link] _italics_ = value!'
		const output = toTelegramMarkdown(input)

		expect(output).toBe('Name \\(test\\) \\[link\\] \\_italics\\_ \\= value\\!')
	})

	it('converts bold and escapes content', () => {
		const input = '**bold** (check)'
		const output = toTelegramMarkdown(input)

		expect(output).toBe('*bold* \\(check\\)')
	})

	it('converts list markers to bullets', () => {
		const input = '- one\n- two'
		const output = toTelegramMarkdown(input)

		expect(output).toBe('• one\n• two')
	})
})
