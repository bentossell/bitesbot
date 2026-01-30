import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { CronService } from '../src/cron/service.js'
import { saveCronStore } from '../src/cron/store.js'
import type { CronStore, CronJob } from '../src/cron/types.js'

const createTempStorePath = async () => {
	const dir = join(tmpdir(), `cron-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
	await mkdir(dir, { recursive: true })
	return { dir, path: join(dir, 'cron.json'), runsDir: join(dir, 'cron-runs') }
}

describe('CronService', () => {
	it('adds and lists jobs', async () => {
		const { dir, path, runsDir } = await createTempStorePath()
		const service = new CronService({ storePath: path, runsDir })
		try {
			const job = await service.add({ name: 'Test job', schedule: { kind: 'every', everyMs: 60000 } })
			const jobs = await service.list()
			expect(jobs.length).toBe(1)
			expect(jobs[0].id).toBe(job.id)
			expect(jobs[0].name).toBe('Test job')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('removes jobs', async () => {
		const { dir, path, runsDir } = await createTempStorePath()
		const service = new CronService({ storePath: path, runsDir })
		try {
			const job = await service.add({ name: 'Remove me', schedule: { kind: 'every', everyMs: 60000 } })
			const removed = await service.remove(job.id)
			expect(removed).toBe(true)
			expect((await service.list()).length).toBe(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('enables and disables jobs', async () => {
		const { dir, path, runsDir } = await createTempStorePath()
		const service = new CronService({ storePath: path, runsDir })
		try {
			const job = await service.add({ name: 'Toggle', schedule: { kind: 'every', everyMs: 60000 } })
			const disabled = await service.enable(job.id, false)
			expect(disabled).toBe(true)
			let jobs = await service.list()
			expect(jobs[0].enabled).toBe(false)
			expect(jobs[0].nextRunAtMs).toBeUndefined()

			const enabled = await service.enable(job.id, true)
			expect(enabled).toBe(true)
			jobs = await service.list()
			expect(jobs[0].enabled).toBe(true)
			expect(jobs[0].nextRunAtMs).toBeDefined()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('run emits job:due and updates schedule', async () => {
		const { dir, path, runsDir } = await createTempStorePath()
		const service = new CronService({ storePath: path, runsDir })
		try {
			const job = await service.add({ name: 'Run now', schedule: { kind: 'every', everyMs: 60000 } })
			const events: CronJob[] = []
			service.on('event', (evt) => {
				if (evt.type === 'job:due') events.push(evt.job)
			})

			const result = await service.run(job.id)
			expect(result).not.toBeNull()
			expect(events.length).toBe(1)
			expect(events[0].id).toBe(job.id)

			const jobs = await service.list()
			expect(jobs[0].lastRunAtMs).toBeDefined()
			expect(jobs[0].nextRunAtMs).toBeDefined()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('emits missed cron runs on start', async () => {
		const { dir, path, runsDir } = await createTempStorePath()
		const now = new Date()
		const lastRun = new Date(now.getTime() - 5 * 60 * 1000).getTime()
		const store: CronStore = {
			version: 1,
			jobs: [
				{
					id: 'job-1',
					name: 'Missed job',
					enabled: true,
					schedule: { kind: 'cron', expr: '* * * * *' },
					message: 'test',
					wakeMode: 'now',
					createdAtMs: lastRun,
					lastRunAtMs: lastRun,
				},
			],
		}

		await saveCronStore(path, store)
		const service = new CronService({ storePath: path, runsDir, checkIntervalMs: 999_999 })

		try {
			const eventPromise = new Promise<CronJob>((resolve) => {
				service.on('event', (evt) => {
					if (evt.type === 'job:due') resolve(evt.job)
				})
			})

			await service.start()
			const job = await eventPromise
			expect(job.name).toBe('Missed job')
		} finally {
			service.stop()
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('queues next-heartbeat jobs and flushes them', async () => {
		const { dir, path, runsDir } = await createTempStorePath()
		const service = new CronService({ storePath: path, runsDir, checkIntervalMs: 10 })
		try {
			await service.start()
			await service.add({
				name: 'Heartbeat job',
				schedule: { kind: 'every', everyMs: 5 },
				wakeMode: 'next-heartbeat',
			})

			await new Promise((resolve) => setTimeout(resolve, 30))
			const pending = service.flushPendingHeartbeat()
			expect(pending.some(job => job.name === 'Heartbeat job')).toBe(true)
		} finally {
			service.stop()
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('emits job:isolated for isolated sessions', async () => {
		const { dir, path, runsDir } = await createTempStorePath()
		const service = new CronService({ storePath: path, runsDir, checkIntervalMs: 10 })
		try {
			await service.start()
			await service.add({
				name: 'Isolated job',
				schedule: { kind: 'every', everyMs: 5 },
				sessionTarget: 'isolated',
			})

			const eventPromise = new Promise<CronJob>((resolve) => {
				service.on('event', (evt) => {
					if (evt.type === 'job:isolated') resolve(evt.job)
				})
			})

			const job = await eventPromise
			expect(job.name).toBe('Isolated job')
		} finally {
			service.stop()
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('adds and lists reminders', async () => {
		const { dir, path, runsDir } = await createTempStorePath()
		const service = new CronService({ storePath: path, runsDir })
		try {
			// Add a regular job
			await service.add({ name: 'Regular job', schedule: { kind: 'every', everyMs: 60000 } })
			// Add reminders
			await service.add({
				name: 'Call Jerry',
				schedule: { kind: 'at', atMs: Date.now() + 3600000 },
				isReminder: true,
				delivery: 'telegram',
			})
			await service.add({
				name: 'Submit expenses',
				schedule: { kind: 'at', atMs: Date.now() + 7200000 },
				isReminder: true,
				delivery: 'email',
			})

			// List all jobs should include both
			const jobs = await service.list()
			expect(jobs.length).toBe(3)

			// List reminders should only include reminders
			const reminders = await service.listReminders()
			expect(reminders.length).toBe(2)
			expect(reminders.map((r) => r.name).sort()).toEqual(['Call Jerry', 'Submit expenses'])
			expect(reminders[0].isReminder).toBe(true)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('formats reminder list correctly', async () => {
		const { dir, path, runsDir } = await createTempStorePath()
		const service = new CronService({ storePath: path, runsDir })
		try {
			await service.add({
				name: 'Email reminder',
				schedule: { kind: 'at', atMs: Date.now() + 3600000 },
				isReminder: true,
				delivery: 'email',
			})
			await service.add({
				name: 'Telegram reminder',
				schedule: { kind: 'at', atMs: Date.now() + 7200000 },
				isReminder: true,
				delivery: 'telegram',
			})

			const reminders = await service.listReminders()
			const formatted = service.formatReminderList(reminders)
			expect(formatted).toContain('🔔')
			expect(formatted).toContain('Email reminder')
			expect(formatted).toContain('[email]')
			expect(formatted).toContain('Telegram reminder')
			// telegram delivery should not show [telegram] tag (it's default)
			expect(formatted).not.toContain('[telegram]')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('shows reminder icon in job list', async () => {
		const { dir, path, runsDir } = await createTempStorePath()
		const service = new CronService({ storePath: path, runsDir })
		try {
			await service.add({
				name: 'Reminder job',
				schedule: { kind: 'at', atMs: Date.now() + 3600000 },
				isReminder: true,
			})
			await service.add({
				name: 'Regular job',
				schedule: { kind: 'every', everyMs: 60000 },
			})

			const jobs = await service.list()
			const formatted = service.formatJobList(jobs)
			expect(formatted).toContain('Reminder job 🔔')
			expect(formatted).not.toContain('Regular job 🔔')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
