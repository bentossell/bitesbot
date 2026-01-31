import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { log, logError } from '../logging/file.js'

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
	/** Whether the result has been injected into parent context */
	resultInjected?: boolean
}

export type SpawnOptions = {
	chatId: number | string
	task: string
	cli: string
	label?: string
	parentSessionId?: string
}

const MAX_CONCURRENT_PER_CHAT = 4
const PENDING_RESULT_TTL_MS = 1000 * 60 * 60 * 6

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
		const record = this.runs.get(runId)
		// Pi debug logging
		if (record?.cli === 'pi') {
			log(`[pi-subagent] markCompleted runId=${runId} result_len=${result?.length ?? 0}`)
		}
		this.update(runId, {
			status: 'completed',
			endedAt: Date.now(),
			result,
		})
	}

	markError(runId: string, error: string): void {
		const record = this.runs.get(runId)
		// Pi debug logging
		if (record?.cli === 'pi') {
			log(`[pi-subagent] markError runId=${runId} error=${error}`)
		}
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

	// Remove completed/error/stopped runs older than TTL
	pruneExpired(ttlMs = PENDING_RESULT_TTL_MS, now = Date.now()): number {
		let pruned = 0
		for (const record of [...this.runs.values()]) {
			const isDone = record.status === 'completed' || record.status === 'error' || record.status === 'stopped'
			if (!isDone) continue
			const endedAt = record.endedAt ?? record.createdAt
			if (endedAt && now - endedAt > ttlMs) {
				if (this.delete(record.runId)) pruned++
			}
		}
		return pruned
	}

	/**
	 * Get completed subagent results that haven't been injected yet
	 */
	getPendingResults(chatId: number | string, parentSessionId?: string): SubagentRunRecord[] {
		if (!parentSessionId) return []
		this.pruneExpired()
		return this.list(chatId).filter(r =>
			(r.status === 'completed' || r.status === 'error') &&
			!r.resultInjected &&
			r.parentSessionId === parentSessionId
		)
	}

	/**
	 * Mark results as injected into parent context
	 */
	markResultsInjected(runIds: string[]): void {
		for (const runId of runIds) {
			this.update(runId, { resultInjected: true })
		}
	}

	/**
	 * Export all records for persistence
	 */
	toJSON(): SubagentRunRecord[] {
		return [...this.runs.values()]
	}

	/**
	 * Import records from persistence
	 */
	fromJSON(records: SubagentRunRecord[]): void {
		this.runs.clear()
		this.byChatId.clear()
		
		for (const record of records) {
			this.runs.set(record.runId, record)
			const chatKey = String(record.chatId)
			if (!this.byChatId.has(chatKey)) {
				this.byChatId.set(chatKey, new Set())
			}
			this.byChatId.get(chatKey)!.add(record.runId)
		}
	}
}

// Persistence path
const DEFAULT_REGISTRY_PATH = join(homedir(), '.config', 'tg-gateway', 'subagent-registry.json')
let registryPath = DEFAULT_REGISTRY_PATH

export const setSubagentRegistryPath = (path: string) => {
	registryPath = path
}

// Global singleton instance
export const subagentRegistry = new SubagentRegistry()

/**
 * Save registry to disk
 */
export const saveSubagentRegistry = async (): Promise<void> => {
	try {
		await mkdir(dirname(registryPath), { recursive: true })
		const data = JSON.stringify(subagentRegistry.toJSON(), null, 2)
		await writeFile(registryPath, data, 'utf-8')
	} catch (err) {
		logError('[subagent-registry] Failed to save:', err)
	}
}

/**
 * Load registry from disk
 */
export const loadSubagentRegistry = async (): Promise<number> => {
	try {
		const data = await readFile(registryPath, 'utf-8')
		const records = JSON.parse(data) as SubagentRunRecord[]
		subagentRegistry.fromJSON(records)
		subagentRegistry.pruneExpired()
		return records.length
	} catch {
		// File doesn't exist or invalid - start fresh
		return 0
	}
}

/**
 * Format pending results for injection into prompt
 */
export const formatPendingResultsForInjection = (
	chatId: number | string,
	parentSessionId?: string
): string | null => {
	const pending = subagentRegistry.getPendingResults(chatId, parentSessionId)
	if (pending.length === 0) return null

	const lines: string[] = ['[Subagent Results]']
	
	for (const record of pending) {
		const label = record.label || `Subagent #${record.runId.slice(0, 8)}`
		const status = record.status === 'completed' ? '✅' : '❌'
		const output = record.result || record.error || '(no output)'
		
		lines.push(`${status} ${label}: ${output}`)
	}
	
	lines.push('[/Subagent Results]')
	
	// Mark as injected
	subagentRegistry.markResultsInjected(pending.map(r => r.runId))
	
	return lines.join('\n')
}
