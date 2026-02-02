export type CronSchedule =
	| { kind: 'at'; atMs: number }
	| { kind: 'every'; everyMs: number }
	| { kind: 'cron'; expr: string; tz?: string }

export type WakeMode = 'now' | 'next-heartbeat'

/** Session target for cron jobs */
export type SessionTarget = 'main' | 'isolated'

/** Thinking level for models that support it (e.g., Opus) */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high'

/** Delivery method for reminder notifications */
export type ReminderDelivery = 'telegram' | 'email' | 'both'

export type CronJobStep =
	| {
			id: string
			action: 'read_file'
			path: string
			maxChars?: number
			required?: boolean
	  }
	| {
			id: string
			action: 'expect_output'
			pattern: string
			flags?: string
			description?: string
	  }

export type CronOutputExpectation = {
	id: string
	pattern: string
	flags?: string
	description?: string
}

export type CronJob = {
	id: string
	name: string
	enabled: boolean
	schedule: CronSchedule
	message: string
	wakeMode: WakeMode
	steps?: CronJobStep[]
	createdAtMs: number
	nextRunAtMs?: number
	lastRunAtMs?: number
	lastStatus?: 'ok' | 'error'
	lastError?: string
	/** Run in isolated session (cron:<jobId>) or main chat session */
	sessionTarget?: SessionTarget
	/** Model override for this job (e.g., 'opus', 'sonnet', 'codex') */
	model?: string
	/** Thinking level override (for models that support extended thinking) */
	thinking?: ThinkingLevel
	/** Summary of last run (for isolated jobs) */
	lastSummary?: string
	/** Duration of last run in ms */
	lastDurationMs?: number
	/** Flag to identify reminder jobs (vs regular cron jobs) */
	isReminder?: boolean
	/** Delivery method for reminders (telegram, email, or both) */
	delivery?: ReminderDelivery
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
	steps?: CronJobStep[]
	sessionTarget?: SessionTarget
	model?: string
	thinking?: ThinkingLevel
	/** Flag to identify reminder jobs */
	isReminder?: boolean
	/** Delivery method for reminders */
	delivery?: ReminderDelivery
}

/** A single cron run record for history */
export type CronRunRecord = {
	jobId: string
	jobName: string
	startedAtMs: number
	completedAtMs?: number
	durationMs?: number
	status: 'running' | 'ok' | 'error' | 'skipped'
	error?: string
	summary?: string
	model?: string
}
