import { describe, it, expect, beforeEach } from 'vitest'
import { SubagentRegistry } from '../src/bridge/subagent-registry.js'

describe('SubagentRegistry', () => {
	let registry: SubagentRegistry

	beforeEach(() => {
		registry = new SubagentRegistry()
	})

	describe('spawn', () => {
		it('creates a new subagent record', () => {
			const record = registry.spawn({
				chatId: 123,
				task: 'run tests',
				cli: 'droid',
				label: 'Testing',
			})

			expect(record.runId).toBeDefined()
			expect(record.chatId).toBe(123)
			expect(record.task).toBe('run tests')
			expect(record.cli).toBe('droid')
			expect(record.label).toBe('Testing')
			expect(record.status).toBe('queued')
			expect(record.createdAt).toBeDefined()
		})

		it('generates unique runIds', () => {
			const r1 = registry.spawn({ chatId: 123, task: 't1', cli: 'droid' })
			const r2 = registry.spawn({ chatId: 123, task: 't2', cli: 'droid' })
			expect(r1.runId).not.toBe(r2.runId)
		})
	})

	describe('get / list', () => {
		it('retrieves record by runId', () => {
			const spawned = registry.spawn({ chatId: 123, task: 'task', cli: 'droid' })
			const retrieved = registry.get(spawned.runId)
			expect(retrieved).toEqual(spawned)
		})

		it('returns undefined for unknown runId', () => {
			expect(registry.get('nonexistent')).toBeUndefined()
		})

		it('lists all records for a chat', () => {
			registry.spawn({ chatId: 123, task: 't1', cli: 'droid' })
			registry.spawn({ chatId: 123, task: 't2', cli: 'droid' })
			registry.spawn({ chatId: 456, task: 't3', cli: 'claude' })

			expect(registry.list(123).length).toBe(2)
			expect(registry.list(456).length).toBe(1)
			expect(registry.list(999).length).toBe(0)
		})
	})

	describe('status transitions', () => {
		it('marks running with session ID', () => {
			const r = registry.spawn({ chatId: 123, task: 'task', cli: 'droid' })
			registry.markRunning(r.runId, 'session-123')

			const updated = registry.get(r.runId)!
			expect(updated.status).toBe('running')
			expect(updated.childSessionId).toBe('session-123')
			expect(updated.startedAt).toBeDefined()
		})

		it('marks completed with result', () => {
			const r = registry.spawn({ chatId: 123, task: 'task', cli: 'droid' })
			registry.markRunning(r.runId, 'sess')
			registry.markCompleted(r.runId, 'Task done!')

			const updated = registry.get(r.runId)!
			expect(updated.status).toBe('completed')
			expect(updated.result).toBe('Task done!')
			expect(updated.endedAt).toBeDefined()
		})

		it('marks error', () => {
			const r = registry.spawn({ chatId: 123, task: 'task', cli: 'droid' })
			registry.markRunning(r.runId, 'sess')
			registry.markError(r.runId, 'Something failed')

			const updated = registry.get(r.runId)!
			expect(updated.status).toBe('error')
			expect(updated.error).toBe('Something failed')
			expect(updated.endedAt).toBeDefined()
		})
	})

	describe('stop', () => {
		it('stops a running subagent', () => {
			const r = registry.spawn({ chatId: 123, task: 'task', cli: 'droid' })
			registry.markRunning(r.runId, 'sess')
			registry.stop(r.runId)

			const updated = registry.get(r.runId)!
			expect(updated.status).toBe('stopped')
			expect(updated.endedAt).toBeDefined()
		})

		it('stops a queued subagent', () => {
			const r = registry.spawn({ chatId: 123, task: 'task', cli: 'droid' })
			registry.stop(r.runId)

			const updated = registry.get(r.runId)!
			expect(updated.status).toBe('stopped')
		})

		it('does not change already completed subagent', () => {
			const r = registry.spawn({ chatId: 123, task: 'task', cli: 'droid' })
			registry.markRunning(r.runId, 'sess')
			registry.markCompleted(r.runId, 'done')
			registry.stop(r.runId)

			expect(registry.get(r.runId)!.status).toBe('completed')
		})

		it('stopAll stops all active for a chat', () => {
			registry.spawn({ chatId: 123, task: 't1', cli: 'droid' })
			const r2 = registry.spawn({ chatId: 123, task: 't2', cli: 'droid' })
			registry.markRunning(r2.runId, 'sess')
			registry.spawn({ chatId: 456, task: 't3', cli: 'droid' })

			const stopped = registry.stopAll(123)
			expect(stopped).toBe(2)
			
			expect(registry.listActive(123).length).toBe(0)
			expect(registry.listActive(456).length).toBe(1)
		})
	})

	describe('concurrency limits', () => {
		it('allows spawn when under limit', () => {
			registry.spawn({ chatId: 123, task: 't1', cli: 'droid' })
			expect(registry.canSpawn(123)).toBe(true)
		})

		it('blocks spawn at limit (4)', () => {
			for (let i = 0; i < 4; i++) {
				registry.spawn({ chatId: 123, task: `t${i}`, cli: 'droid' })
			}
			expect(registry.canSpawn(123)).toBe(false)
		})

		it('allows spawn after one completes', () => {
			const records = []
			for (let i = 0; i < 4; i++) {
				records.push(registry.spawn({ chatId: 123, task: `t${i}`, cli: 'droid' }))
			}
			expect(registry.canSpawn(123)).toBe(false)

			registry.markRunning(records[0].runId, 'sess')
			registry.markCompleted(records[0].runId, 'done')
			
			expect(registry.canSpawn(123)).toBe(true)
		})
	})

	describe('pending results', () => {
		it('returns completed results for matching parent session', () => {
			const r = registry.spawn({ chatId: 123, task: 'task', cli: 'droid', parentSessionId: 'sess-1' })
			registry.markRunning(r.runId, 'sess')
			registry.markCompleted(r.runId, 'Result here')

			const pending = registry.getPendingResults(123, 'sess-1')
			expect(pending.length).toBe(1)
			expect(pending[0].result).toBe('Result here')
		})

		it('excludes already injected results', () => {
			const r = registry.spawn({ chatId: 123, task: 'task', cli: 'droid', parentSessionId: 'sess-1' })
			registry.markRunning(r.runId, 'sess')
			registry.markCompleted(r.runId, 'Result')
			registry.markResultsInjected([r.runId])

			expect(registry.getPendingResults(123, 'sess-1').length).toBe(0)
		})

		it('includes error results', () => {
			const r = registry.spawn({ chatId: 123, task: 'task', cli: 'droid', parentSessionId: 'sess-1' })
			registry.markRunning(r.runId, 'sess')
			registry.markError(r.runId, 'Failed!')

			const pending = registry.getPendingResults(123, 'sess-1')
			expect(pending.length).toBe(1)
			expect(pending[0].error).toBe('Failed!')
		})

		it('skips results for non-matching parent session', () => {
			const r = registry.spawn({ chatId: 123, task: 'task', cli: 'droid', parentSessionId: 'sess-1' })
			registry.markRunning(r.runId, 'sess')
			registry.markCompleted(r.runId, 'Result')

			expect(registry.getPendingResults(123, 'sess-2').length).toBe(0)
		})

		it('prunes expired results before returning', () => {
			const now = Date.now()
			const r = registry.spawn({ chatId: 123, task: 'task', cli: 'droid', parentSessionId: 'sess-1' })
			registry.markRunning(r.runId, 'sess')
			registry.markCompleted(r.runId, 'Result')
			registry.update(r.runId, { endedAt: now - 1000 * 60 * 60 * 7 })

			expect(registry.getPendingResults(123, 'sess-1').length).toBe(0)
			expect(registry.get(r.runId)).toBeUndefined()
		})
	})

	describe('prune', () => {
		it('removes old completed runs keeping last N', () => {
			for (let i = 0; i < 15; i++) {
				const r = registry.spawn({ chatId: 123, task: `t${i}`, cli: 'droid' })
				registry.markRunning(r.runId, 'sess')
				registry.markCompleted(r.runId, `done${i}`)
			}

			const pruned = registry.prune(123, 5)
			expect(pruned).toBe(10)
			expect(registry.list(123).length).toBe(5)
		})

		it('does not prune active runs', () => {
			for (let i = 0; i < 10; i++) {
				const r = registry.spawn({ chatId: 123, task: `t${i}`, cli: 'droid' })
				if (i < 5) {
					registry.markRunning(r.runId, 'sess')
					registry.markCompleted(r.runId, `done${i}`)
				}
				// Leave last 5 as queued
			}

			const pruned = registry.prune(123, 2)
			expect(pruned).toBe(3) // Only prune completed ones beyond keepLast
			expect(registry.list(123).length).toBe(7) // 2 completed + 5 queued
		})
	})

	describe('persistence (toJSON / fromJSON)', () => {
		it('exports and imports records', () => {
			registry.spawn({ chatId: 123, task: 't1', cli: 'droid', label: 'Test' })
			const r2 = registry.spawn({ chatId: 456, task: 't2', cli: 'claude' })
			registry.markRunning(r2.runId, 'sess')

			const exported = registry.toJSON()
			expect(exported.length).toBe(2)

			const newRegistry = new SubagentRegistry()
			newRegistry.fromJSON(exported)

			expect(newRegistry.list(123).length).toBe(1)
			expect(newRegistry.list(456).length).toBe(1)
			expect(newRegistry.get(r2.runId)?.status).toBe('running')
		})
	})
})
