import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CronJob, CronJobCreate, CronStore, WakeMode } from './types.js'
import { loadCronStore, saveCronStore, generateId, findJob, updateJob, removeJob, addJob } from './store.js'
import { calculateNextRun, isDue, formatSchedule } from './scheduler.js'

const DEFAULT_MESSAGE = 'Check HEARTBEAT.md and run any scheduled tasks. If nothing needs attention, reply HEARTBEAT_OK.'
const DEFAULT_CRON_PATH = join(homedir(), '.config', 'tg-gateway', 'cron.json')
const CHECK_INTERVAL_MS = 60_000 // Check every minute

export type CronEventType = 'job:due' | 'job:complete' | 'job:error'

export type CronEvent =
	| { type: 'job:due'; job: CronJob }
	| { type: 'job:complete'; job: CronJob }
	| { type: 'job:error'; job: CronJob; error: string }

export type CronServiceEvents = {
	event: [CronEvent]
}

export type CronServiceConfig = {
	storePath?: string
	checkIntervalMs?: number
}

export class CronService extends EventEmitter<CronServiceEvents> {
	private store: CronStore = { version: 1, jobs: [] }
	private timer: NodeJS.Timeout | null = null
	private readonly storePath: string
	private readonly checkIntervalMs: number
	private pendingHeartbeat: CronJob[] = []

	constructor(config: CronServiceConfig = {}) {
		super()
		this.storePath = config.storePath ?? DEFAULT_CRON_PATH
		this.checkIntervalMs = config.checkIntervalMs ?? CHECK_INTERVAL_MS
	}

	async start(): Promise<void> {
		this.store = await loadCronStore(this.storePath)
		console.log(`[cron] Loaded ${this.store.jobs.length} jobs`)

		// Calculate next run for any jobs that don't have it set
		for (const job of this.store.jobs) {
			if (job.enabled && !job.nextRunAtMs) {
				const nextRun = calculateNextRun(job.schedule)
				if (nextRun) {
					this.store = updateJob(this.store, job.id, { nextRunAtMs: nextRun })
				}
			}
		}
		await this.save()

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
			} else {
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
		}
		this.store = addJob(this.store, job)
		await this.save()
		console.log(`[cron] Added job: ${job.name} (${job.id})`)
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

	formatJobList(jobs: CronJob[]): string {
		if (jobs.length === 0) return 'No cron jobs configured.'
		return jobs
			.map((j) => {
				const status = j.enabled ? '✓' : '○'
				const next = j.nextRunAtMs ? new Date(j.nextRunAtMs).toLocaleString() : 'n/a'
				return `${status} ${j.id}: ${j.name}\n   ${formatSchedule(j.schedule)} | next: ${next}`
			})
			.join('\n\n')
	}
}
