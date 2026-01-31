import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

type LogLevel = 'info' | 'error'

const logDir = join(homedir(), '.config', 'tg-gateway', 'logs')
const logFile = join(logDir, 'gateway.log')
let initialized = false

const ensureLogDir = async () => {
	if (initialized) return
	await mkdir(logDir, { recursive: true })
	initialized = true
}

export const logToFile = async (
	level: LogLevel,
	message: string,
	context?: Record<string, unknown>
) => {
	try {
		await ensureLogDir()
		const entry = {
			ts: new Date().toISOString(),
			level,
			message,
			...context,
		}
		await appendFile(logFile, `${JSON.stringify(entry)}\n`, 'utf8')
	} catch {
		console.error('[logging] Failed to write log entry')
	}
}

/** Timestamp prefix for console logs (HH:MM:SS.mmm) */
const ts = (): string => {
	const now = new Date()
	return now.toISOString().slice(11, 23)
}

/** Timestamped console.log */
export const log = (...args: unknown[]): void => {
	console.log(ts(), ...args)
}

/** Timestamped console.error */
export const logError = (...args: unknown[]): void => {
	console.error(ts(), ...args)
}

/** Timestamped console.warn */
export const logWarn = (...args: unknown[]): void => {
	console.warn(ts(), ...args)
}
