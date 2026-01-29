import { describe, expect, it } from 'vitest'
import {
	buildMemoryToolInstructions,
	formatMemoryToolResultPrompt,
	parseMemoryToolCall,
} from '../src/memory/tools.js'

describe('memory tool parsing', () => {
	it('parses memory_search tool call', () => {
		const call = parseMemoryToolCall('{"tool":"memory_search","query":"status"}')
		expect(call).toEqual({ tool: 'memory_search', query: 'status', maxResults: undefined, minScore: undefined })
	})

	it('parses memory_get tool call', () => {
		const call = parseMemoryToolCall('{"tool":"memory_get","path":"memory/foo.md","from":2,"lines":5}')
		expect(call).toEqual({ tool: 'memory_get', path: 'memory/foo.md', from: 2, lines: 5 })
	})

	it('returns null for invalid tool call', () => {
		expect(parseMemoryToolCall('not json')).toBeNull()
		expect(parseMemoryToolCall('{"tool":"memory_search"}')).toBeNull()
	})
})

describe('memory tool prompt formatting', () => {
	it('builds instructions', () => {
		const instructions = buildMemoryToolInstructions()
		expect(instructions).toContain('memory_search')
		expect(instructions).toContain('memory_get')
	})

	it('formats tool result prompt', () => {
		const prompt = formatMemoryToolResultPrompt(
			{ tool: 'memory_search', query: 'hello' },
			{ tool: 'memory_search', results: [] },
			'Original question'
		)
		expect(prompt).toContain('Tool result (memory_search):')
		expect(prompt).toContain('Original question')
	})
})
