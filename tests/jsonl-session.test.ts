import { describe, it, expect } from 'vitest'

// Simulates the translateEvent logic for droid stream-json format
const translateStreamEvent = (event: Record<string, unknown>): { type: string; text?: string; sessionId?: string } | null => {
	switch (event.type) {
		case 'system':
			if (event.subtype === 'init' && event.session_id) {
				return { type: 'started', sessionId: event.session_id as string }
			}
			return null

		case 'message':
			// Droid stream-json: { type: 'message', role: 'assistant', text: '...' }
			if (event.role === 'assistant' && event.text) {
				return { type: 'text', text: event.text as string }
			}
			return null

		case 'completion':
			return { 
				type: 'completed', 
				sessionId: event.session_id as string,
				text: event.finalText as string
			}

		default:
			return null
	}
}

describe('droid stream-json event parsing', () => {
	it('should parse system init event', () => {
		const event = {
			type: 'system',
			subtype: 'init',
			cwd: '/Users/mini/agent-gateway-workspace',
			session_id: '34ee79b3-bb52-427c-970b-df0a89487472',
			model: 'claude-opus-4-5-20251101'
		}

		const result = translateStreamEvent(event)
		expect(result).toEqual({ type: 'started', sessionId: '34ee79b3-bb52-427c-970b-df0a89487472' })
	})

	it('should parse assistant message with flat text field', () => {
		// ACTUAL format from: droid exec --output-format stream-json
		const event = {
			type: 'message',
			role: 'assistant',
			id: '57f58562-a273-460e-9819-32563d66bc60',
			text: 'Hello! 👋 I\'m ready to help. What would you like to work on today?',
			timestamp: 1769549161387,
			session_id: '34ee79b3-bb52-427c-970b-df0a89487472'
		}

		const result = translateStreamEvent(event)
		expect(result).not.toBeNull()
		expect(result?.type).toBe('text')
		expect(result?.text).toBe('Hello! 👋 I\'m ready to help. What would you like to work on today?')
	})

	it('should parse completion event', () => {
		const event = {
			type: 'completion',
			finalText: '4',
			numTurns: 1,
			session_id: '9748b6c2-ac6a-4b69-afc3-461b6583166d'
		}

		const result = translateStreamEvent(event)
		expect(result?.type).toBe('completed')
		expect(result?.text).toBe('4')
		expect(result?.sessionId).toBe('9748b6c2-ac6a-4b69-afc3-461b6583166d')
	})

	it('should ignore user messages', () => {
		const event = {
			type: 'message',
			role: 'user',
			text: 'what is 2+2'
		}

		const result = translateStreamEvent(event)
		expect(result).toBeNull()
	})
})
