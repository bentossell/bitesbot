export type CronSchedule =
	| { kind: 'at'; atMs: number }
	| { kind: 'every'; everyMs: number }
	| { kind: 'cron'; expr: string; tz?: string }

export type WakeMode = 'now' | 'next-heartbeat'

export type CronJob = {
	id: string
	name: string
	enabled: boolean
	schedule: CronSchedule
	message: string
	wakeMode: WakeMode
	createdAtMs: number
	nextRunAtMs?: number
	lastRunAtMs?: number
	lastStatus?: 'ok' | 'error'
	lastError?: string
}

export type CronStore = {
	version: 1
	jobs: CronJob[]
}

export type CronJobCreate = {
	name: string
	schedule: CronSchedule
	message?: string
	wakeMode?: WakeMode
}
