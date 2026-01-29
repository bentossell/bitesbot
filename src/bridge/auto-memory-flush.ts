import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { syncSessionToMemory } from './memory-sync.js'

type FlushState = {
	lastFlushAtMs: number
	lastSizeBytes: number
}

const stateByWorkspaceAndDate = new Map<string, FlushState>()

const utcDateString = (d: Date): string => d.toISOString().slice(0, 10)

const getEnvInt = (name: string, fallback: number): number => {
	const raw = process.env[name]
	if (!raw) return fallback
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) ? parsed : fallback
}

export type AutoFlushResult =
	| { didFlush: false; reason: string }
	| { didFlush: true; reason: string; entries: number; path: string }

/**
 * Pre-threshold memory flush hook: when the sessions/YYYY-MM-DD.jsonl grows past a threshold,
 * write/append a durable summary into memory/YYYY-MM-DD.md.
 */
export const maybeAutoFlushSessionToMemory = async (
	workspaceDir: string,
	options?: { date?: string }
): Promise<AutoFlushResult> => {
	const date = options?.date ?? utcDateString(new Date())
	const key = `${workspaceDir}::${date}`
	const sessionsPath = join(workspaceDir, 'sessions', `${date}.jsonl`)

	const thresholdBytes = getEnvInt('TG_GATEWAY_MEMORY_FLUSH_THRESHOLD_BYTES', 150_000)
	const minIntervalMs = getEnvInt('TG_GATEWAY_MEMORY_FLUSH_MIN_INTERVAL_MS', 10 * 60 * 1000)

	let st: FlushState = stateByWorkspaceAndDate.get(key) ?? {
		lastFlushAtMs: 0,
		lastSizeBytes: 0,
	}

	let sizeBytes = 0
	try {
		sizeBytes = (await stat(sessionsPath)).size
	} catch {
		return { didFlush: false, reason: 'no sessions log yet' }
	}

	if (sizeBytes < thresholdBytes) {
		st.lastSizeBytes = sizeBytes
		stateByWorkspaceAndDate.set(key, st)
		return { didFlush: false, reason: 'below threshold' }
	}

	const now = Date.now()
	if (now - st.lastFlushAtMs < minIntervalMs) {
		st.lastSizeBytes = sizeBytes
		stateByWorkspaceAndDate.set(key, st)
		return { didFlush: false, reason: 'min interval not reached' }
	}

	// Avoid repeated flushes if size hasn't changed meaningfully.
	if (sizeBytes <= st.lastSizeBytes) {
		return { didFlush: false, reason: 'no growth since last check' }
	}

	const result = await syncSessionToMemory(workspaceDir, date)
	st = { lastFlushAtMs: now, lastSizeBytes: sizeBytes }
	stateByWorkspaceAndDate.set(key, st)

	if (!result.written) {
		return { didFlush: false, reason: 'sync produced no summary' }
	}
	return { didFlush: true, reason: 'threshold reached', entries: result.entries, path: result.path }
}
