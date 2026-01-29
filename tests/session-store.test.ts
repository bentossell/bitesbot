import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../src/bridge/jsonl-session.js'
import { logSessionMessage, setWorkspaceDir } from '../src/bridge/session-store.js'

describe('createSessionStore', () => {
	describe('session management', () => {
		it('returns undefined for non-existent session', () => {
			const store = createSessionStore()
			expect(store.get(123)).toBeUndefined()
		})

		it('can delete session', () => {
			const store = createSessionStore()
			store.sessions.set(123, {} as never)
			expect(store.get(123)).toBeDefined()
			store.delete(123)
			expect(store.get(123)).toBeUndefined()
		})
	})

	describe('resume tokens', () => {
		it('stores and retrieves resume token per CLI', () => {
			const store = createSessionStore()
			const token = { engine: 'droid', sessionId: 'sess-123' }
			store.setResumeToken(123, 'droid', token)
			expect(store.getResumeToken(123, 'droid')).toEqual(token)
		})

		it('keeps separate tokens per CLI', () => {
			const store = createSessionStore()
			const droidToken = { engine: 'droid', sessionId: 'droid-sess' }
			const claudeToken = { engine: 'claude', sessionId: 'claude-sess' }
			
			store.setResumeToken(123, 'droid', droidToken)
			store.setResumeToken(123, 'claude', claudeToken)
			
			expect(store.getResumeToken(123, 'droid')).toEqual(droidToken)
			expect(store.getResumeToken(123, 'claude')).toEqual(claudeToken)
		})

		it('keeps separate tokens per chat', () => {
			const store = createSessionStore()
			const token1 = { engine: 'droid', sessionId: 'sess-1' }
			const token2 = { engine: 'droid', sessionId: 'sess-2' }
			
			store.setResumeToken(111, 'droid', token1)
			store.setResumeToken(222, 'droid', token2)
			
			expect(store.getResumeToken(111, 'droid')).toEqual(token1)
			expect(store.getResumeToken(222, 'droid')).toEqual(token2)
		})

		it('returns undefined for non-existent token', () => {
			const store = createSessionStore()
			expect(store.getResumeToken(123, 'droid')).toBeUndefined()
		})
	})

	describe('active CLI tracking', () => {
		it('sets and gets active CLI per chat', () => {
			const store = createSessionStore()
			store.setActiveCli(123, 'claude')
			expect(store.getActiveCli(123)).toBe('claude')
		})

		it('returns undefined when no active CLI set', () => {
			const store = createSessionStore()
			expect(store.getActiveCli(123)).toBeUndefined()
		})

		it('tracks different CLIs per chat', () => {
			const store = createSessionStore()
			store.setActiveCli(111, 'claude')
			store.setActiveCli(222, 'droid')
			
			expect(store.getActiveCli(111)).toBe('claude')
			expect(store.getActiveCli(222)).toBe('droid')
		})
	})

	describe('busy state', () => {
		it('returns false when no session', () => {
			const store = createSessionStore()
			expect(store.isBusy(123)).toBe(false)
		})

		it('returns true when session exists', () => {
			const store = createSessionStore()
			store.sessions.set(123, {} as never)
			expect(store.isBusy(123)).toBe(true)
		})
	})

	describe('message queue', () => {
		it('starts with empty queue', () => {
			const store = createSessionStore()
			expect(store.getQueueLength(123)).toBe(0)
		})

		it('enqueues and dequeues messages', () => {
			const store = createSessionStore()
			const msg = { id: 'msg-1', text: 'hello', createdAt: Date.now() }
			
			store.enqueue(123, msg)
			expect(store.getQueueLength(123)).toBe(1)
			
			const dequeued = store.dequeue(123)
			expect(dequeued).toEqual(msg)
			expect(store.getQueueLength(123)).toBe(0)
		})

		it('maintains FIFO order', () => {
			const store = createSessionStore()
			const msg1 = { id: '1', text: 'first', createdAt: 1 }
			const msg2 = { id: '2', text: 'second', createdAt: 2 }
			const msg3 = { id: '3', text: 'third', createdAt: 3 }
			
			store.enqueue(123, msg1)
			store.enqueue(123, msg2)
			store.enqueue(123, msg3)
			
			expect(store.dequeue(123)?.id).toBe('1')
			expect(store.dequeue(123)?.id).toBe('2')
			expect(store.dequeue(123)?.id).toBe('3')
		})

		it('returns undefined when dequeuing empty queue', () => {
			const store = createSessionStore()
			expect(store.dequeue(123)).toBeUndefined()
		})

		it('tracks separate queues per chat', () => {
			const store = createSessionStore()
			store.enqueue(111, { id: 'a', text: 'chat1', createdAt: 1 })
			store.enqueue(222, { id: 'b', text: 'chat2', createdAt: 2 })
			
			expect(store.getQueueLength(111)).toBe(1)
			expect(store.getQueueLength(222)).toBe(1)
			
			expect(store.dequeue(111)?.text).toBe('chat1')
			expect(store.dequeue(222)?.text).toBe('chat2')
		})
	})

	describe('session logging', () => {
		it('writes subagent entries to jsonl and markdown transcripts', async () => {
			const workspaceDir = await mkdtemp(join(tmpdir(), 'tg-gateway-'))
			setWorkspaceDir(workspaceDir)

			const entry = {
				timestamp: '2026-01-29T12:00:00.000Z',
				chatId: 42,
				role: 'assistant' as const,
				text: 'Subagent result',
				sessionId: 'sess-123',
				cli: 'claude',
				isSubagent: true,
				subagentRunId: 'run-abc',
				parentSessionId: 'parent-1',
			}

			await logSessionMessage(entry)

			const date = entry.timestamp.split('T')[0]
			const jsonlPath = join(workspaceDir, 'sessions', `${date}.jsonl`)
			const mdPath = join(workspaceDir, 'sessions', `${date}.md`)

			const jsonl = await readFile(jsonlPath, 'utf-8')
			const parsed = JSON.parse(jsonl.trim())
			expect(parsed.isSubagent).toBe(true)
			expect(parsed.subagentRunId).toBe('run-abc')

			const md = await readFile(mdPath, 'utf-8')
			expect(md).toContain('subagent:run-abc')
			expect(md).toContain('Subagent result')

			await rm(workspaceDir, { recursive: true, force: true })
		})
	})
})
