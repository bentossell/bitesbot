import { describe, it, expect } from 'vitest'
import { JsonlSession, type BridgeEvent } from '../src/bridge/jsonl-session.js'
import type { CLIManifest } from '../src/bridge/manifest.js'

const createSession = (cli = 'droid') => {
	const manifest: CLIManifest = {
		name: cli,
		command: 'echo',
		args: [],
		inputMode: 'jsonl',
	}
	return new JsonlSession('chat-1', manifest, process.cwd())
}

const getTranslate = (session: JsonlSession) => {
	const translate = (session as unknown as { translateEvent: (event: Record<string, unknown>) => void }).translateEvent
	return translate.bind(session)
}

describe('jsonl-session event translation', () => {
	it('translates Claude system init event', () => {
		const session = createSession('claude')
		const events: BridgeEvent[] = []
		session.on('event', (evt) => events.push(evt))

		const translate = getTranslate(session)
		translate({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-3-5' })

		expect(events[0]).toEqual({ type: 'started', sessionId: 'sess-1', model: 'claude-3-5' })
	})

	it('translates Claude assistant text', () => {
		const session = createSession('claude')
		const events: BridgeEvent[] = []
		session.on('event', (evt) => events.push(evt))

		const translate = getTranslate(session)
		translate({
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'Hello there' }] },
		})

		expect(events[0]).toEqual({ type: 'text', text: 'Hello there' })
	})

	it('translates Claude tool start/end', () => {
		const session = createSession('claude')
		const events: BridgeEvent[] = []
		session.on('event', (evt) => events.push(evt))

		const translate = getTranslate(session)
		translate({
			type: 'assistant',
			message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'file' } }] },
		})
		translate({
			type: 'user',
			message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }] },
		})

		expect(events[0]).toEqual({ type: 'tool_start', toolId: 'tool-1', name: 'Read', input: { path: 'file' } })
		expect(events[1]).toEqual({ type: 'tool_end', toolId: 'tool-1', isError: false, preview: 'ok' })
	})

	it('translates Claude result event', () => {
		const session = createSession('claude')
		const events: BridgeEvent[] = []
		session.on('event', (evt) => events.push(evt))

		const translate = getTranslate(session)
		translate({ type: 'result', session_id: 'sess-2', result: 'final answer', is_error: false, total_cost_usd: 0.02 })

		expect(events[0]).toEqual({
			type: 'completed',
			sessionId: 'sess-2',
			answer: 'final answer',
			isError: false,
			cost: 0.02,
		})
	})

	it('translates Droid events', () => {
		const session = createSession('droid')
		const events: BridgeEvent[] = []
		session.on('event', (evt) => events.push(evt))

		const translate = getTranslate(session)
		translate({ type: 'session_start', session_id: 'droid-sess', model: 'droid-1' })
		translate({ type: 'message', role: 'assistant', text: 'hello' })
		translate({ type: 'tool_start', tool: 'Read', id: 'tool-3', input: { path: 'file' } })
		translate({ type: 'tool_end', id: 'tool-3', output: 'done' })
		translate({ type: 'completion', finalText: 'final', session_id: 'droid-sess' })

		expect(events[0]).toEqual({ type: 'started', sessionId: 'droid-sess', model: 'droid-1' })
		expect(events[1]).toEqual({ type: 'text', text: 'hello' })
		expect(events[2]).toEqual({ type: 'tool_start', toolId: 'tool-3', name: 'Read', input: { path: 'file' } })
		expect(events[3]).toEqual({ type: 'tool_end', toolId: 'tool-3', isError: false, preview: 'done' })
		expect(events[4]).toEqual({ type: 'completed', sessionId: 'droid-sess', answer: 'final', isError: false })
	})

	it('translates Droid tool start/end', () => {
		const session = createSession('droid')
		const events: BridgeEvent[] = []
		session.on('event', (evt) => events.push(evt))

		const translate = getTranslate(session)
		translate({ type: 'tool_start', tool: 'Read', id: 'tool-4', input: { path: 'file' } })
		translate({ type: 'tool_end', id: 'tool-4', output: 'done' })

		expect(events[0]).toEqual({ type: 'tool_start', toolId: 'tool-4', name: 'Read', input: { path: 'file' } })
		expect(events[1]).toEqual({ type: 'tool_end', toolId: 'tool-4', isError: false, preview: 'done' })
	})
})
