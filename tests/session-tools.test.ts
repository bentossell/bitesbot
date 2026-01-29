import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	buildSessionToolInstructions,
	formatSessionToolResultPrompt,
	parseSessionToolCall,
	runSessionTool,
} from '../src/bridge/session-tools.js'

describe('session tool parsing', () => {
	it('parses sessions_list', () => {
		expect(parseSessionToolCall('{"tool":"sessions_list","maxDates":10}'))
			.toEqual({ tool: 'sessions_list', maxDates: 10 })
	})

	it('parses sessions_history', () => {
		expect(parseSessionToolCall('{"tool":"sessions_history","date":"2026-01-29","chatId":123,"limit":20,"includeSubagents":true}'))
			.toEqual({ tool: 'sessions_history', date: '2026-01-29', chatId: 123, sessionId: undefined, limit: 20, includeSubagents: true })
	})

	it('parses sessions_send', () => {
		expect(parseSessionToolCall('{"tool":"sessions_send","chatId":123,"text":"hi"}'))
			.toEqual({ tool: 'sessions_send', chatId: 123, text: 'hi' })
	})

	it('parses sessions_spawn', () => {
		expect(parseSessionToolCall('{"tool":"sessions_spawn","task":"do work","label":"L","cli":"DROID"}'))
			.toEqual({ tool: 'sessions_spawn', chatId: undefined, task: 'do work', label: 'L', cli: 'droid' })
	})

	it('returns null for invalid tool call', () => {
		expect(parseSessionToolCall('not json')).toBeNull()
		expect(parseSessionToolCall('{"tool":"sessions_send"}')).toBeNull()
	})
})

describe('session tool prompt formatting', () => {
	it('builds instructions', () => {
		const instructions = buildSessionToolInstructions()
		expect(instructions).toContain('sessions_list')
		expect(instructions).toContain('sessions_history')
		expect(instructions).toContain('sessions_send')
	})

	it('formats tool result prompt', () => {
		const prompt = formatSessionToolResultPrompt(
			{ tool: 'sessions_list', maxDates: 1 },
			{ tool: 'sessions_list', result: { dates: [] } },
			'Original question'
		)
		expect(prompt).toContain('Tool result (sessions_list):')
		expect(prompt).toContain('Original question')
	})
})

describe('runSessionTool', () => {
	it('lists and reads history from workspace sessions logs', async () => {
		const workspaceDir = await mkdtemp(join(tmpdir(), 'tg-gateway-'))
		try {
			await mkdir(join(workspaceDir, 'sessions'), { recursive: true })
			const date = '2026-01-29'
			const logPath = join(workspaceDir, 'sessions', `${date}.jsonl`)
			const entry1 = { timestamp: '2026-01-29T00:00:00.000Z', chatId: 123, role: 'user', text: 'hi', sessionId: 's1', cli: 'droid' }
			const entry2 = { timestamp: '2026-01-29T00:00:01.000Z', chatId: 123, role: 'assistant', text: 'hello', sessionId: 's1', cli: 'droid' }
			const entry3 = { timestamp: '2026-01-29T00:00:02.000Z', chatId: 999, role: 'user', text: 'other', sessionId: 's2', cli: 'claude' }
			await writeFile(logPath, [entry1, entry2, entry3].map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')

			const list = await runSessionTool(
				{ tool: 'sessions_list', maxDates: 5 },
				{ workspaceDir, currentChatId: 123, sendToChat: async () => {} }
			)
			expect(list.tool).toBe('sessions_list')
			if (list.tool === 'sessions_list') {
				expect(list.result.dates[0]?.date).toBe(date)
				expect(list.result.dates[0]?.entries).toBe(3)
			}

			const history = await runSessionTool(
				{ tool: 'sessions_history', date, chatId: 123, limit: 50 },
				{ workspaceDir, currentChatId: 123, sendToChat: async () => {} }
			)
			expect(history.tool).toBe('sessions_history')
			if (history.tool === 'sessions_history') {
				expect(history.result.entries).toHaveLength(2)
				expect(history.result.entries[0]?.text).toBe('hi')
			}
		} finally {
			await rm(workspaceDir, { recursive: true, force: true })
		}
	})
})
