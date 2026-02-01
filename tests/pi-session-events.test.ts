/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest'
import { JsonlSession, type BridgeEvent, type ToolExecutor } from '../src/bridge/jsonl-session.js'
import type { CLIManifest } from '../src/bridge/manifest.js'

const mockPiManifest: CLIManifest = {
	name: 'pi',
	command: '/bin/echo',
	args: ['--mode', 'json'],
	inputMode: 'arg',
}

// Helper to access private session properties for testing
const getSessionInternals = (session: JsonlSession) => session as any

describe('Pi session event handling', () => {
	let events: BridgeEvent[]

	beforeEach(() => {
		events = []
	})

	const createSession = (toolExecutor?: ToolExecutor) => {
		const session = new JsonlSession(123, mockPiManifest, '/tmp', { toolExecutor })
		session.on('event', (e) => events.push(e))
		return session
	}

	it('turn_end captures text but does not emit completion', () => {
		const session = createSession()
		const internals = getSessionInternals(session)
		
		// Simulate session start
		internals._resumeToken = { engine: 'pi', sessionId: 'pi-sess-1' }
		
		// Simulate turn_end event
		internals.translateEvent({
			type: 'turn_end',
			message: {
				role: 'assistant',
				content: [{ type: 'text', text: 'Hello from Pi' }]
			}
		})

		// turn_end should NOT emit completion (wait for agent_end)
		const completedEvent = events.find(e => e.type === 'completed')
		expect(completedEvent).toBeUndefined()
		
		// But it should capture the text
		expect(internals._lastText).toBe('Hello from Pi')
	})

	it('emits completion on agent_end even without lastText', () => {
		const session = createSession()
		const internals = getSessionInternals(session)
		
		internals._resumeToken = { engine: 'pi', sessionId: 'pi-sess-1' }
		internals._lastText = '' // Empty text
		
		// Simulate agent_end event with messages
		internals.translateEvent({
			type: 'agent_end',
			messages: [
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'Final answer from messages' }]
				}
			]
		})

		const completedEvent = events.find(e => e.type === 'completed')
		expect(completedEvent).toBeDefined()
		if (completedEvent?.type === 'completed') {
			expect(completedEvent.answer).toBe('Final answer from messages')
		}
	})

	it('emits completion on agent_end with fallback text when no messages', () => {
		const session = createSession()
		const internals = getSessionInternals(session)
		
		internals._resumeToken = { engine: 'pi', sessionId: 'pi-sess-1' }
		internals._lastText = '' // Empty text
		
		// Simulate agent_end event without messages
		internals.translateEvent({
			type: 'agent_end',
			messages: []
		})

		const completedEvent = events.find(e => e.type === 'completed')
		expect(completedEvent).toBeDefined()
		if (completedEvent?.type === 'completed') {
			expect(completedEvent.answer).toBe('(no response)')
		}
	})

	it('emits completion only on agent_end, not turn_end', () => {
		const session = createSession()
		const internals = getSessionInternals(session)
		
		internals._resumeToken = { engine: 'pi', sessionId: 'pi-sess-1' }
		
		// First: turn_end (should capture text but not complete)
		internals.translateEvent({
			type: 'turn_end',
			message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
		})
		
		expect(events.filter(e => e.type === 'completed')).toHaveLength(0)
		
		// Second: agent_end (should emit completion with captured text)
		internals.translateEvent({ type: 'agent_end', messages: [] })

		const completedEvents = events.filter(e => e.type === 'completed')
		expect(completedEvents).toHaveLength(1)
		expect(completedEvents[0].type === 'completed' && completedEvents[0].answer).toBe('Hello')
	})

	it('tracks pending tools correctly during tool execution', () => {
		const session = createSession()
		const internals = getSessionInternals(session)
		
		// Simulate tool_execution_start
		internals.translateEvent({
			type: 'tool_execution_start',
			toolCallId: 'tool-123',
			toolName: 'memory_store',
			args: { key: 'test' }
		})
		
		expect(internals.pendingTools.size).toBe(1)
		expect(internals.pendingTools.has('tool-123')).toBe(true)
		
		// Simulate tool_execution_end
		internals.translateEvent({
			type: 'tool_execution_end',
			toolCallId: 'tool-123',
			toolName: 'memory_store',
			result: 'ok',
			isError: false
		})
		
		expect(internals.pendingTools.size).toBe(0)
	})

	it('emits tool_start and tool_end events for Pi tools', () => {
		const session = createSession()
		const internals = getSessionInternals(session)
		
		internals.translateEvent({
			type: 'tool_execution_start',
			toolCallId: 'tool-abc',
			toolName: 'sessions_list',
			args: { chatId: 123 }
		})
		
		const toolStartEvent = events.find(e => e.type === 'tool_start')
		expect(toolStartEvent).toBeDefined()
		if (toolStartEvent?.type === 'tool_start') {
			expect(toolStartEvent.toolId).toBe('tool-abc')
			expect(toolStartEvent.name).toBe('sessions_list')
		}
		
		internals.translateEvent({
			type: 'tool_execution_end',
			toolCallId: 'tool-abc',
			toolName: 'sessions_list',
			result: ['session1', 'session2'],
			isError: false
		})
		
		const toolEndEvent = events.find(e => e.type === 'tool_end')
		expect(toolEndEvent).toBeDefined()
		if (toolEndEvent?.type === 'tool_end') {
			expect(toolEndEvent.toolId).toBe('tool-abc')
			expect(toolEndEvent.isError).toBe(false)
		}
	})
})
