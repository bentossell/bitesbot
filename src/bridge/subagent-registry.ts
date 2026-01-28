import { randomUUID } from 'node:crypto'

export type SubagentStatus = 'queued' | 'running' | 'completed' | 'error' | 'stopped'

export type SubagentRunRecord = {
	runId: string
	chatId: number | string
	parentSessionId?: string
	childSessionId?: string
	cli: string
	task: string
	label?: string
	status: SubagentStatus
	createdAt: number
	startedAt?: number
	endedAt?: number
	result?: string
	error?: string
}

export type SpawnOptions = {
	chatId: number | string
	task: string
	cli: string
	label?: string
	parentSessionId?: string
}

const MAX_CONCURRENT_PER_CHAT = 4

export class SubagentRegistry {
	private runs = new Map<string, SubagentRunRecord>()
	private byChatId = new Map<string, Set<string>>() // chatId -> runIds

	spawn(opts: SpawnOptions): SubagentRunRecord {
		const runId = randomUUID()
		const chatKey = String(opts.chatId)

		const record: SubagentRunRecord = {
			runId,
			chatId: opts.chatId,
			parentSessionId: opts.parentSessionId,
			cli: opts.cli,
			task: opts.task,
			label: opts.label,
			status: 'queued',
			createdAt: Date.now(),
		}

		this.runs.set(runId, record)

		if (!this.byChatId.has(chatKey)) {
			this.byChatId.set(chatKey, new Set())
		}
		this.byChatId.get(chatKey)!.add(runId)

		return record
	}

	get(runId: string): SubagentRunRecord | undefined {
		return this.runs.get(runId)
	}

	list(chatId: number | string): SubagentRunRecord[] {
		const chatKey = String(chatId)
		const runIds = this.byChatId.get(chatKey)
		if (!runIds) return []
		return [...runIds].map(id => this.runs.get(id)).filter(Boolean) as SubagentRunRecord[]
	}

	listActive(chatId: number | string): SubagentRunRecord[] {
		return this.list(chatId).filter(r => r.status === 'queued' || r.status === 'running')
	}

	canSpawn(chatId: number | string): boolean {
		return this.listActive(chatId).length < MAX_CONCURRENT_PER_CHAT
	}

	update(runId: string, patch: Partial<SubagentRunRecord>): void {
		const record = this.runs.get(runId)
		if (!record) return
		Object.assign(record, patch)
	}

	markRunning(runId: string, childSessionId: string): void {
		this.update(runId, {
			status: 'running',
			startedAt: Date.now(),
			childSessionId,
		})
	}

	markCompleted(runId: string, result: string): void {
		this.update(runId, {
			status: 'completed',
			endedAt: Date.now(),
			result,
		})
	}

	markError(runId: string, error: string): void {
		this.update(runId, {
			status: 'error',
			endedAt: Date.now(),
			error,
		})
	}

	stop(runId: string): SubagentRunRecord | undefined {
		const record = this.runs.get(runId)
		if (!record) return undefined
		if (record.status === 'queued' || record.status === 'running') {
			this.update(runId, {
				status: 'stopped',
				endedAt: Date.now(),
			})
		}
		return record
	}

	stopAll(chatId: number | string): number {
		const active = this.listActive(chatId)
		for (const record of active) {
			this.stop(record.runId)
		}
		return active.length
	}

	delete(runId: string): boolean {
		const record = this.runs.get(runId)
		if (!record) return false
		
		const chatKey = String(record.chatId)
		this.byChatId.get(chatKey)?.delete(runId)
		this.runs.delete(runId)
		return true
	}

	// Clean up old completed/error runs (keep last N per chat)
	prune(chatId: number | string, keepLast = 10): number {
		const all = this.list(chatId)
		const completed = all
			.filter(r => r.status === 'completed' || r.status === 'error' || r.status === 'stopped')
			.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
		
		let pruned = 0
		for (let i = keepLast; i < completed.length; i++) {
			if (this.delete(completed[i].runId)) {
				pruned++
			}
		}
		return pruned
	}
}

// Global singleton instance
export const subagentRegistry = new SubagentRegistry()
