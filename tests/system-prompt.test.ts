import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../src/bridge/system-prompt.js'

describe('buildSystemPrompt', () => {
	it('includes memory tool instructions when enabled', () => {
		const prompt = buildSystemPrompt({
			workingDirectory: '/tmp/workspace',
			promptMode: 'full',
			memoryEnabled: true,
		})
		expect(prompt).toContain('{"tool":"memory_search"')
		expect(prompt).toContain('{"tool":"memory_get"')
	})

	it('omits memory tool instructions when disabled', () => {
		const prompt = buildSystemPrompt({
			workingDirectory: '/tmp/workspace',
			promptMode: 'full',
			memoryEnabled: false,
		})
		expect(prompt).not.toContain('{"tool":"memory_search"')
	})

	it('keeps minimal mode focused', () => {
		const prompt = buildSystemPrompt({
			workingDirectory: '/tmp/workspace',
			promptMode: 'minimal',
		})
		expect(prompt).not.toContain('/spawn')
		expect(prompt).not.toContain('## Commands')
		expect(prompt).not.toContain('HEARTBEAT_OK')
	})

	it('includes heartbeats in full mode', () => {
		const prompt = buildSystemPrompt({
			workingDirectory: '/tmp/workspace',
			promptMode: 'full',
		})
		expect(prompt).toContain('HEARTBEAT_OK')
	})
})
