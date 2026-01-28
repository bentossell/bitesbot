import { describe, it, expect } from 'vitest'
import { calculateNextRun, findMissedRuns, isDue, parseScheduleArg, formatSchedule } from '../src/cron/scheduler.js'
import type { CronSchedule } from '../src/cron/types.js'

describe('parseScheduleArg', () => {
	it('parses "every Xm" format', () => {
		const result = parseScheduleArg('every 30m')
		expect(result).toEqual({ kind: 'every', everyMs: 30 * 60 * 1000 })
	})

	it('parses "every Xh" format', () => {
		const result = parseScheduleArg('every 2h')
		expect(result).toEqual({ kind: 'every', everyMs: 2 * 60 * 60 * 1000 })
	})

	it('parses "every Xs" format', () => {
		const result = parseScheduleArg('every 45s')
		expect(result).toEqual({ kind: 'every', everyMs: 45 * 1000 })
	})

	it('parses "at" format with ISO date', () => {
		const result = parseScheduleArg('at 2024-06-15T10:00:00Z')
		expect(result).toEqual({ kind: 'at', atMs: new Date('2024-06-15T10:00:00Z').getTime() })
	})

	it('parses "cron" format with expression', () => {
		const result = parseScheduleArg('cron "0 9 * * *"')
		expect(result).toEqual({ kind: 'cron', expr: '0 9 * * *' })
	})

	it('parses cron without quotes', () => {
		const result = parseScheduleArg('cron 0 9 * * *')
		expect(result).toEqual({ kind: 'cron', expr: '0 9 * * *' })
	})

	it('returns null for invalid input', () => {
		expect(parseScheduleArg('invalid')).toBeNull()
		expect(parseScheduleArg('every abc')).toBeNull()
		expect(parseScheduleArg('')).toBeNull()
	})
})

describe('calculateNextRun', () => {
	it('returns future time for "at" schedule', () => {
		const futureTime = Date.now() + 60000
		const schedule: CronSchedule = { kind: 'at', atMs: futureTime }
		const result = calculateNextRun(schedule)
		expect(result).toBe(futureTime)
	})

	it('returns null for past "at" schedule', () => {
		const pastTime = Date.now() - 60000
		const schedule: CronSchedule = { kind: 'at', atMs: pastTime }
		const result = calculateNextRun(schedule)
		expect(result).toBeNull()
	})

	it('returns now + interval for "every" schedule', () => {
		const now = new Date()
		const schedule: CronSchedule = { kind: 'every', everyMs: 30 * 60 * 1000 }
		const result = calculateNextRun(schedule, now)
		expect(result).toBe(now.getTime() + 30 * 60 * 1000)
	})

	it('calculates next run for cron "0 9 * * *" (daily at 9am)', () => {
		const now = new Date('2024-06-15T08:00:00')
		const schedule: CronSchedule = { kind: 'cron', expr: '0 9 * * *' }
		const result = calculateNextRun(schedule, now)
		expect(result).not.toBeNull()
		const nextRun = new Date(result!)
		expect(nextRun.getHours()).toBe(9)
		expect(nextRun.getMinutes()).toBe(0)
	})

	it('calculates next run for cron with step (*/15 * * * *)', () => {
		const now = new Date('2024-06-15T10:07:00')
		const schedule: CronSchedule = { kind: 'cron', expr: '*/15 * * * *' }
		const result = calculateNextRun(schedule, now)
		expect(result).not.toBeNull()
		const nextRun = new Date(result!)
		expect(nextRun.getMinutes()).toBe(15)
	})

	it('handles cron with comma-separated values', () => {
		const now = new Date('2024-06-15T10:05:00')
		const schedule: CronSchedule = { kind: 'cron', expr: '0,30 * * * *' }
		const result = calculateNextRun(schedule, now)
		expect(result).not.toBeNull()
		const nextRun = new Date(result!)
		expect([0, 30]).toContain(nextRun.getMinutes())
	})

	it('handles cron with range', () => {
		const now = new Date('2024-06-15T10:05:00')
		const schedule: CronSchedule = { kind: 'cron', expr: '10-20 * * * *' }
		const result = calculateNextRun(schedule, now)
		expect(result).not.toBeNull()
		const nextRun = new Date(result!)
		expect(nextRun.getMinutes()).toBeGreaterThanOrEqual(10)
		expect(nextRun.getMinutes()).toBeLessThanOrEqual(20)
	})
})

describe('findMissedRuns', () => {
	it('returns empty array for non-cron schedules', () => {
		const schedule: CronSchedule = { kind: 'every', everyMs: 60000 }
		const result = findMissedRuns(schedule, Date.now() - 3600000)
		expect(result).toEqual([])
	})

	it('returns empty array when no lastRunAtMs', () => {
		const schedule: CronSchedule = { kind: 'cron', expr: '* * * * *' }
		const result = findMissedRuns(schedule, undefined)
		expect(result).toEqual([])
	})

	it('finds missed runs for every-minute cron', () => {
		const now = new Date('2024-06-15T10:05:00')
		const lastRun = new Date('2024-06-15T10:00:00').getTime()
		const schedule: CronSchedule = { kind: 'cron', expr: '* * * * *' }
		const result = findMissedRuns(schedule, lastRun, now)
		expect(result.length).toBe(4) // 10:01, 10:02, 10:03, 10:04
	})

	it('finds missed hourly runs', () => {
		const now = new Date('2024-06-15T14:05:00')
		const lastRun = new Date('2024-06-15T10:00:00').getTime()
		const schedule: CronSchedule = { kind: 'cron', expr: '0 * * * *' }
		const result = findMissedRuns(schedule, lastRun, now)
		expect(result.length).toBe(4) // 11:00, 12:00, 13:00, 14:00
	})

	it('returns empty when no runs missed', () => {
		const now = new Date('2024-06-15T10:00:30')
		const lastRun = new Date('2024-06-15T10:00:00').getTime()
		const schedule: CronSchedule = { kind: 'cron', expr: '0 * * * *' }
		const result = findMissedRuns(schedule, lastRun, now)
		expect(result.length).toBe(0)
	})
})

describe('isDue', () => {
	it('returns true when current time >= nextRunAtMs', () => {
		const pastTime = Date.now() - 1000
		expect(isDue(pastTime)).toBe(true)
	})

	it('returns false when current time < nextRunAtMs', () => {
		const futureTime = Date.now() + 60000
		expect(isDue(futureTime)).toBe(false)
	})

	it('returns false when nextRunAtMs is undefined', () => {
		expect(isDue(undefined)).toBe(false)
	})

	it('returns true at exact boundary', () => {
		const now = new Date()
		expect(isDue(now.getTime(), now)).toBe(true)
	})
})

describe('formatSchedule', () => {
	it('formats "at" schedule', () => {
		const schedule: CronSchedule = { kind: 'at', atMs: new Date('2024-06-15T10:00:00Z').getTime() }
		expect(formatSchedule(schedule)).toBe('at 2024-06-15T10:00:00.000Z')
	})

	it('formats "every" schedule in minutes', () => {
		const schedule: CronSchedule = { kind: 'every', everyMs: 30 * 60 * 1000 }
		expect(formatSchedule(schedule)).toBe('every 30m')
	})

	it('formats "every" schedule in hours', () => {
		const schedule: CronSchedule = { kind: 'every', everyMs: 2 * 60 * 60 * 1000 }
		expect(formatSchedule(schedule)).toBe('every 2h')
	})

	it('formats "cron" schedule', () => {
		const schedule: CronSchedule = { kind: 'cron', expr: '0 9 * * *' }
		expect(formatSchedule(schedule)).toBe('cron "0 9 * * *"')
	})
})
