import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CronJob, CronJobCreate, CronRunRecord, CronStore } from './types.js'
import { loadCronStore, saveCronStore, generateId, findJob, updateJob, removeJob, addJob } from './store.js'
import { calculateNextRun, isDue, formatSchedule, findMissedRuns } from './scheduler.js'
import {
	appendRunRecord,
	createRunRecord,
	completeRunRecord,
	errorRunRecord,
	loadRunHistory,
	formatRunHistory,
	setRunsDir,
} from './run-history.js'

const DEFAULT_MESSAGE = 'Check HEARTBEAT.md and run any scheduled tasks. If nothing needs attention, reply HEARTBEAT_OK.'
const DEFAULT_CRON_PATH = join(homedir(), '.config', 'tg-gateway', 'cron.json')
const DEFAULT_RUNS_DIR = join(homedir(), '.config', 'tg-gateway', 'cron-runs')
const CHECK_INTERVAL_MS = 60_000 // Check every minute

export type CronEventType = 'job:due' | 'job:complete' | 'job:error' | 'job:isolated'

export type CronEvent =
	| { type: 'job:due'; job: CronJob }
	| { type: 'job:complete'; job: CronJob }
	| { type: 'job:error'; job: CronJob; error: string }
	| { type: 'job:isolated'; job: CronJob; runRecord: CronRunRecord }

export type CronServiceEvents = {
	event: [CronEvent]
}

export type CronServiceConfig = {
	storePath?: string
	runsDir?: string
	checkIntervalMs?: number
}

export class CronService extends EventEmitter<CronServiceEvents> {
	private store: CronStore = { version: 1, jobs: [] }
	private timer: NodeJS.Timeout | null = null
	private readonly storePath: string
	private readonly checkIntervalMs: number
	private pendingHeartbeat: CronJob[] = []
	// Track active isolated job runs for completion
	private activeRuns: Map<string, CronRunRecord> = new Map()

	constructor(config: CronServiceConfig = {}) {
		super()
		this.storePath = config.storePath ?? DEFAULT_CRON_PATH
		this.checkIntervalMs = config.checkIntervalMs ?? CHECK_INTERVAL_MS
		setRunsDir(config.runsDir ?? DEFAULT_RUNS_DIR)
	}

	async start(): Promise<void> {
		this.store = await loadCronStore(this.storePath)
		console.log(`[cron] Loaded ${this.store.jobs.length} jobs`)

		const now = new Date()
		const missedJobIds: string[] = []

		// Check for missed runs and calculate next run for each job
		for (const job of this.store.jobs) {
			if (!job.enabled) continue

			// Check if any runs were missed since last run
			const missedRuns = findMissedRuns(job.schedule, job.lastRunAtMs, now)
			if (missedRuns.length > 0) {
				console.log(`[cron] Job "${job.name}" missed ${missedRuns.length} run(s) - will run now`)
				// Update lastRunAtMs to the most recent missed time so we don't re-trigger
				this.store = updateJob(this.store, job.id, { lastRunAtMs: missedRuns[missedRuns.length - 1] })
				missedJobIds.push(job.id)
			}

			// Always recalculate next run from cron expression on restart
			// This ensures we don't miss runs due to stale/incorrect nextRunAtMs values
			const nextRun = calculateNextRun(job.schedule, now)
			if (nextRun && nextRun !== job.nextRunAtMs) {
				console.log(`[cron] Recalculated next run for "${job.name}": ${new Date(nextRun).toISOString()}`)
				this.store = updateJob(this.store, job.id, { nextRunAtMs: nextRun })
			}
		}
		await this.save()

		// Emit events for missed jobs (run them now)
		for (const jobId of missedJobIds) {
			const job = findJob(this.store, jobId)
			if (!job) continue
			if (job.wakeMode === 'next-heartbeat') {
				this.pendingHeartbeat.push(job)
			} else {
				this.emit('event', { type: 'job:due', job })
			}
			this.scheduleNextRun(job)
		}

		this.timer = setInterval(() => this.check(), this.checkIntervalMs)
		console.log(`[cron] Started, checking every ${this.checkIntervalMs / 1000}s`)
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
		console.log('[cron] Stopped')
	}

	private async save(): Promise<void> {
		await saveCronStore(this.storePath, this.store)
	}

	private check(): void {
		const now = new Date()
		for (const job of this.store.jobs) {
			if (!job.enabled) continue
			if (!isDue(job.nextRunAtMs, now)) continue

			if (job.wakeMode === 'next-heartbeat') {
				this.pendingHeartbeat.push(job)
				this.scheduleNextRun(job)
			} else if (job.sessionTarget === 'isolated') {
				// Isolated jobs get their own session with run tracking
				const runRecord = createRunRecord(job.id, job.name, job.model)
				this.activeRuns.set(job.id, runRecord)
				void appendRunRecord(runRecord)
				this.emit('event', { type: 'job:isolated', job, runRecord })
				this.scheduleNextRun(job)
			} else {
				// Main session jobs (default)
				this.emit('event', { type: 'job:due', job })
				this.scheduleNextRun(job)
			}
		}
	}

	private scheduleNextRun(job: CronJob): void {
		const nextRun = calculateNextRun(job.schedule)
		this.store = updateJob(this.store, job.id, {
			nextRunAtMs: nextRun ?? undefined,
			lastRunAtMs: Date.now(),
		})
		void this.save()
	}

	// Called by bridge when a heartbeat cycle runs
	flushPendingHeartbeat(): CronJob[] {
		const jobs = [...this.pendingHeartbeat]
		this.pendingHeartbeat = []
		return jobs
	}

	async list(): Promise<CronJob[]> {
		return this.store.jobs
	}

	async add(input: CronJobCreate): Promise<CronJob> {
		const nextRun = calculateNextRun(input.schedule)
		const job: CronJob = {
			id: generateId(),
			name: input.name,
			enabled: true,
			schedule: input.schedule,
			message: input.message ?? DEFAULT_MESSAGE,
			wakeMode: input.wakeMode ?? 'now',
			createdAtMs: Date.now(),
			nextRunAtMs: nextRun !== null ? nextRun : undefined,
			sessionTarget: input.sessionTarget,
			model: input.model,
			thinking: input.thinking,
		}
		this.store = addJob(this.store, job)
		await this.save()
		console.log(`[cron] Added job: ${job.name} (${job.id})${job.sessionTarget === 'isolated' ? ' [isolated]' : ''}`)
		return job
	}

	async remove(id: string): Promise<boolean> {
		const job = findJob(this.store, id)
		if (!job) return false
		this.store = removeJob(this.store, id)
		await this.save()
		console.log(`[cron] Removed job: ${job.name} (${id})`)
		return true
	}

	async enable(id: string, enabled: boolean): Promise<boolean> {
		const job = findJob(this.store, id)
		if (!job) return false
		const nextRunCalc = enabled ? calculateNextRun(job.schedule) : null
		const nextRun = nextRunCalc !== null ? nextRunCalc : undefined
		this.store = updateJob(this.store, id, { enabled, nextRunAtMs: nextRun })
		await this.save()
		return true
	}

	async run(id: string): Promise<CronJob | null> {
		const job = findJob(this.store, id)
		if (!job) return null
		this.emit('event', { type: 'job:due', job })
		this.scheduleNextRun(job)
		return job
	}

	markComplete(id: string, error?: string): void {
		const status = error ? 'error' : 'ok'
		this.store = updateJob(this.store, id, {
			lastStatus: status,
			lastError: error,
		})
		void this.save()
	}

	/**
	 * Mark an isolated job run as complete with summary
	 */
	async markIsolatedComplete(id: string, summary?: string, error?: string): Promise<void> {
		const activeRun = this.activeRuns.get(id)
		if (activeRun) {
			const finalRecord = error
				? errorRunRecord(activeRun, error)
				: completeRunRecord(activeRun, summary)
			await appendRunRecord(finalRecord)
			this.activeRuns.delete(id)
		}

		const status = error ? 'error' : 'ok'
		const durationMs = activeRun ? Date.now() - activeRun.startedAtMs : undefined
		this.store = updateJob(this.store, id, {
			lastStatus: status,
			lastError: error,
			lastSummary: summary,
			lastDurationMs: durationMs,
		})
		await this.save()
	}

	/**
	 * Get run history for a job
	 */
	async getRunHistory(id: string, limit = 50): Promise<CronRunRecord[]> {
		return loadRunHistory(id, limit)
	}

	/**
	 * Format run history for display
	 */
	async formatRunHistory(id: string, limit = 10): Promise<string> {
		const runs = await loadRunHistory(id, limit)
		return formatRunHistory(runs)
	}

	formatJobList(jobs: CronJob[]): string {
		if (jobs.length === 0) return 'No cron jobs configured.'
		return jobs
			.map((j) => {
				const status = j.enabled ? '✓' : '○'
				const next = j.nextRunAtMs ? new Date(j.nextRunAtMs).toLocaleString() : 'n/a'
				const isolated = j.sessionTarget === 'isolated' ? ' [isolated]' : ''
				const model = j.model ? ` [${j.model}]` : ''
				return `${status} ${j.id}: ${j.name}${isolated}${model}\n   ${formatSchedule(j.schedule)} | next: ${next}`
			})
			.join('\n\n')
	}
}
