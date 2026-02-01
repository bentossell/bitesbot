import { Cron } from 'croner'
import type { CronSchedule } from './types.js'

const MAX_MISSED_RUNS = 24 * 60

const resolveCronNextRun = (expr: string, tz: string | undefined, now: Date): number | null => {
	const trimmed = expr.trim()
	if (!trimmed) return null
	try {
		const cron = new Cron(trimmed, { timezone: tz?.trim() || undefined, catch: false })
		const next = cron.nextRun(now)
		return next ? next.getTime() : null
	} catch {
		return null
	}
}

export const calculateNextRun = (schedule: CronSchedule, now: Date = new Date()): number | null => {
	switch (schedule.kind) {
		case 'at':
			return schedule.atMs > now.getTime() ? schedule.atMs : null

		case 'every':
			return now.getTime() + schedule.everyMs

		case 'cron':
				return resolveCronNextRun(schedule.expr, schedule.tz, now)
	}
}

/**
 * Find missed cron runs between lastRunAt and now.
 * Returns timestamps of all missed runs (if any).
 * Only checks cron schedules (not 'at' or 'every').
 */
export const findMissedRuns = (
	schedule: CronSchedule,
	lastRunAtMs: number | undefined,
	now: Date = new Date()
): number[] => {
	if (schedule.kind !== 'cron' || !lastRunAtMs) return []

	const missed: number[] = []
	const expr = schedule.expr.trim()
	if (!expr) return []

	try {
		const cron = new Cron(expr, { timezone: schedule.tz?.trim() || undefined, catch: false })
		let cursor = new Date(lastRunAtMs)
		const nowMs = now.getTime()
		for (let i = 0; i < MAX_MISSED_RUNS; i++) {
			const next = cron.nextRun(cursor)
			if (!next) break
			const nextMs = next.getTime()
			if (nextMs >= nowMs) break
			missed.push(nextMs)
			cursor = new Date(nextMs + 1)
		}
	} catch {
		return []
	}

	return missed
}

export const isDue = (nextRunAtMs: number | undefined, now: Date = new Date()): boolean => {
	if (!nextRunAtMs) return false
	return now.getTime() >= nextRunAtMs
}

export const parseScheduleArg = (arg: string): CronSchedule | null => {
	// "every 30m" or "every 1h"
	const everyMatch = arg.match(/^every\s+(\d+)(m|h|s)$/i)
	if (everyMatch) {
		const [, num, unit] = everyMatch
		const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000 }
		return { kind: 'every', everyMs: parseInt(num, 10) * multipliers[unit.toLowerCase()] }
	}

	// "at 2024-01-27T10:00:00"
	const atMatch = arg.match(/^at\s+(.+)$/i)
	if (atMatch) {
		const date = new Date(atMatch[1])
		if (!isNaN(date.getTime())) {
			return { kind: 'at', atMs: date.getTime() }
		}
	}

	// "cron 0 9 * * *"
	const cronMatch = arg.match(/^cron\s+"?([^"]+)"?$/i)
	if (cronMatch) {
		return { kind: 'cron', expr: cronMatch[1].trim() }
	}

	return null
}

export const formatSchedule = (schedule: CronSchedule): string => {
	switch (schedule.kind) {
		case 'at':
			return `at ${new Date(schedule.atMs).toISOString()}`
		case 'every': {
			const mins = schedule.everyMs / 60000
			if (mins >= 60) return `every ${mins / 60}h`
			return `every ${mins}m`
		}
		case 'cron':
			return `cron "${schedule.expr}"`
	}
}
