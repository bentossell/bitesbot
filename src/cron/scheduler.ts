import type { CronSchedule } from './types.js'

// Simple cron parser for common patterns
// Supports: "* * * * *" (min hour dom mon dow)
const parseCronExpr = (expr: string, now: Date): number | null => {
	const parts = expr.trim().split(/\s+/)
	if (parts.length !== 5) return null

	const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = parts

	// Get current time in timezone (simplified - just use local for now)
	const current = new Date(now)

	const matchField = (expr: string, value: number, max: number): boolean => {
		if (expr === '*') return true
		if (expr.includes(',')) {
			return expr.split(',').some((p) => matchField(p.trim(), value, max))
		}
		if (expr.includes('/')) {
			const [, step] = expr.split('/')
			const stepNum = parseInt(step, 10)
			return value % stepNum === 0
		}
		if (expr.includes('-')) {
			const [start, end] = expr.split('-').map((n) => parseInt(n, 10))
			return value >= start && value <= end
		}
		return parseInt(expr, 10) === value
	}

	// Find next matching time (look ahead up to 1 week)
	const maxIterations = 7 * 24 * 60
	const candidate = new Date(current)
	candidate.setSeconds(0, 0)
	candidate.setMinutes(candidate.getMinutes() + 1)

	for (let i = 0; i < maxIterations; i++) {
		const min = candidate.getMinutes()
		const hour = candidate.getHours()
		const dom = candidate.getDate()
		const mon = candidate.getMonth() + 1
		const dow = candidate.getDay()

		if (
			matchField(minExpr, min, 59) &&
			matchField(hourExpr, hour, 23) &&
			matchField(domExpr, dom, 31) &&
			matchField(monExpr, mon, 12) &&
			matchField(dowExpr, dow, 6)
		) {
			return candidate.getTime()
		}

		candidate.setMinutes(candidate.getMinutes() + 1)
	}

	return null
}

export const calculateNextRun = (schedule: CronSchedule, now: Date = new Date()): number | null => {
	switch (schedule.kind) {
		case 'at':
			return schedule.atMs > now.getTime() ? schedule.atMs : null

		case 'every':
			return now.getTime() + schedule.everyMs

		case 'cron':
			return parseCronExpr(schedule.expr, now)
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
	const parts = schedule.expr.trim().split(/\s+/)
	if (parts.length !== 5) return []

	const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = parts

	const matchField = (expr: string, value: number): boolean => {
		if (expr === '*') return true
		if (expr.includes(',')) {
			return expr.split(',').some((p) => matchField(p.trim(), value))
		}
		if (expr.includes('/')) {
			const [, step] = expr.split('/')
			const stepNum = parseInt(step, 10)
			return value % stepNum === 0
		}
		if (expr.includes('-')) {
			const [start, end] = expr.split('-').map((n) => parseInt(n, 10))
			return value >= start && value <= end
		}
		return parseInt(expr, 10) === value
	}

	// Start from the minute after last run
	const candidate = new Date(lastRunAtMs)
	candidate.setSeconds(0, 0)
	candidate.setMinutes(candidate.getMinutes() + 1)

	const nowMs = now.getTime()

	// Check each minute between last run and now (up to 24 hours max to avoid long loops)
	const maxIterations = 24 * 60
	for (let i = 0; i < maxIterations && candidate.getTime() < nowMs; i++) {
		const min = candidate.getMinutes()
		const hour = candidate.getHours()
		const dom = candidate.getDate()
		const mon = candidate.getMonth() + 1
		const dow = candidate.getDay()

		if (
			matchField(minExpr, min) &&
			matchField(hourExpr, hour) &&
			matchField(domExpr, dom) &&
			matchField(monExpr, mon) &&
			matchField(dowExpr, dow)
		) {
			missed.push(candidate.getTime())
		}

		candidate.setMinutes(candidate.getMinutes() + 1)
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
