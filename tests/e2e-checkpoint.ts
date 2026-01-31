import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'

type Checkpoint = {
	version: 1
	completed: string[]
}

const CHECKPOINT_ENABLED = process.env.TG_E2E_RUN === '1' && process.env.TG_E2E_CHECKPOINT !== '0'
const CHECKPOINT_PATH = process.env.TG_E2E_CHECKPOINT_PATH
	?? join(tmpdir(), 'bitesbot-e2e-checkpoint.json')

type LockState = {
	chain?: Promise<void>
}

const globalLock = globalThis as unknown as { __bitesbotE2eLock__?: LockState }

const loadCheckpoint = (): Checkpoint => {
	if (!existsSync(CHECKPOINT_PATH)) {
		return { version: 1, completed: [] }
	}
	try {
		const raw = readFileSync(CHECKPOINT_PATH, 'utf-8')
		const parsed = JSON.parse(raw) as Checkpoint
		if (parsed.version === 1 && Array.isArray(parsed.completed)) {
			return parsed
		}
	} catch {
		// ignore malformed checkpoint
	}
	return { version: 1, completed: [] }
}

const saveCheckpoint = (checkpoint: Checkpoint): void => {
	mkdirSync(dirname(CHECKPOINT_PATH), { recursive: true })
	writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2), 'utf-8')
}

const getCurrentTestName = (fallback: string): string => {
	const state = (expect as unknown as { getState?: () => { currentTestName?: string } }).getState?.()
	return state?.currentTestName || fallback
}

const hasCompleted = (name: string): boolean => {
	if (!CHECKPOINT_ENABLED) return false
	const checkpoint = loadCheckpoint()
	return checkpoint.completed.includes(name)
}

export const isE2eTestCompleted = (name?: string): boolean => {
	if (!CHECKPOINT_ENABLED) return false
	const testName = name ?? getCurrentTestName('')
	if (!testName) return false
	return hasCompleted(testName)
}

const markCompleted = (name: string): void => {
	if (!CHECKPOINT_ENABLED) return
	const checkpoint = loadCheckpoint()
	if (checkpoint.completed.includes(name)) return
	checkpoint.completed.push(name)
	saveCheckpoint(checkpoint)
}

type TestBody = () => unknown | Promise<unknown>
type TestFn = (name: string, fn: TestBody, timeout?: number) => ReturnType<typeof it>

export const acquireE2eLock = async (): Promise<() => void> => {
	if (!CHECKPOINT_ENABLED) {
		return () => {}
	}
	const state = globalLock.__bitesbotE2eLock__ ?? { chain: undefined }
	globalLock.__bitesbotE2eLock__ = state

	let release!: () => void
	const next = new Promise<void>((resolve) => { release = resolve })
	const prev = state.chain ?? Promise.resolve()
	state.chain = prev.then(() => next)
	await prev
	return () => release()
}

export const e2eTest = ((name: string, fn: TestBody, timeout?: number) => {
	return it(name, async () => {
		const testName = getCurrentTestName(name)
		if (hasCompleted(testName)) {
			console.log(`[e2e] Skipping completed: ${testName}`)
			return
		}
		await fn()
		markCompleted(testName)
	}, timeout)
}) as TestFn & { skipIf: (condition: boolean) => TestFn }

e2eTest.skipIf = (condition: boolean) => {
	return (name: string, fn: TestBody, timeout?: number) => {
		if (condition) {
			return it.skip(name, fn, timeout)
		}
		return e2eTest(name, fn, timeout)
	}
}
