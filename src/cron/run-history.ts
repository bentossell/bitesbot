import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CronRunRecord } from './types.js'

const DEFAULT_RUNS_DIR = join(homedir(), '.config', 'tg-gateway', 'cron-runs')

let runsDir = DEFAULT_RUNS_DIR

export const setRunsDir = (dir: string): void => {
	runsDir = dir
}

export const getRunsDir = (): string => runsDir

const getRunFilePath = (jobId: string): string => {
	return join(runsDir, `${jobId}.jsonl`)
}

/**
 * Append a run record to the job's history file
 */
export const appendRunRecord = async (record: CronRunRecord): Promise<void> => {
	const filePath = getRunFilePath(record.jobId)
	await mkdir(dirname(filePath), { recursive: true })
	const line = JSON.stringify(record) + '\n'
	await appendFile(filePath, line, 'utf-8')
}

/**
 * Load run history for a job (most recent first)
 */
export const loadRunHistory = async (jobId: string, limit = 50): Promise<CronRunRecord[]> => {
	const filePath = getRunFilePath(jobId)
	try {
		const content = await readFile(filePath, 'utf-8')
		const lines = content.trim().split('\n').filter(Boolean)
		const records = lines.map(line => JSON.parse(line) as CronRunRecord)
		// Return most recent first, limited
		return records.reverse().slice(0, limit)
	} catch {
		return []
	}
}

/**
 * Create a run record for a job that's starting
 */
export const createRunRecord = (jobId: string, jobName: string, model?: string): CronRunRecord => {
	return {
		jobId,
		jobName,
		startedAtMs: Date.now(),
		status: 'running',
		model,
	}
}

/**
 * Complete a run record with success
 */
export const completeRunRecord = (
	record: CronRunRecord,
	summary?: string
): CronRunRecord => {
	const completedAtMs = Date.now()
	return {
		...record,
		completedAtMs,
		durationMs: completedAtMs - record.startedAtMs,
		status: 'ok',
		summary,
	}
}

/**
 * Complete a run record with error
 */
export const errorRunRecord = (
	record: CronRunRecord,
	error: string
): CronRunRecord => {
	const completedAtMs = Date.now()
	return {
		...record,
		completedAtMs,
		durationMs: completedAtMs - record.startedAtMs,
		status: 'error',
		error,
	}
}

/**
 * Mark a run record as skipped
 */
export const skipRunRecord = (
	record: CronRunRecord,
	reason: string
): CronRunRecord => {
	const completedAtMs = Date.now()
	return {
		...record,
		completedAtMs,
		durationMs: completedAtMs - record.startedAtMs,
		status: 'skipped',
		error: reason,
	}
}

/**
 * Format run history for display
 */
export const formatRunHistory = (runs: CronRunRecord[]): string => {
	if (runs.length === 0) return 'No run history.'

	return runs.map(run => {
		const date = new Date(run.startedAtMs).toLocaleString()
		const duration = run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : 'n/a'
		const statusIcon = run.status === 'ok' ? '✓' : run.status === 'error' ? '✗' : '○'
		const model = run.model ? ` [${run.model}]` : ''
		const summary = run.summary ? `\n   ${run.summary.slice(0, 100)}${run.summary.length > 100 ? '...' : ''}` : ''
		const error = run.error ? `\n   Error: ${run.error.slice(0, 100)}` : ''
		return `${statusIcon} ${date} (${duration})${model}${summary}${error}`
	}).join('\n\n')
}
