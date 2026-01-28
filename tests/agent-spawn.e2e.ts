import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DROID_PATH = join(homedir(), '.local/bin/droid')
const TIMEOUT_MS = 60_000

const hasDroid = existsSync(DROID_PATH)
const hasApiKeys = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)

describe.skipIf(!hasDroid || !hasApiKeys)('agent-spawn e2e', () => {
	describe('droid CLI', () => {
		it('spawns and receives session_start event', async () => {
			const events: Record<string, unknown>[] = []
			let proc: ChildProcess | null = null

			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					proc?.kill()
					reject(new Error('Timeout waiting for session_start'))
				}, TIMEOUT_MS)

				proc = spawn(DROID_PATH, [
					'exec',
					'--output-format', 'stream-json',
					'--auto', 'high',
					'What is 2+2? Reply with just the number.',
				], {
					cwd: process.cwd(),
					env: process.env,
					stdio: ['pipe', 'pipe', 'pipe'],
				})

				proc.stdin?.end()

				const rl = createInterface({ input: proc.stdout! })
				
				rl.on('line', (line) => {
					try {
						const event = JSON.parse(line)
						events.push(event)
						
						// Check for session start
						if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
							clearTimeout(timer)
							proc?.kill()
							resolve()
						}
						if (event.type === 'session_start' && event.session_id) {
							clearTimeout(timer)
							proc?.kill()
							resolve()
						}
					} catch {
						// Non-JSON line, ignore
					}
				})

				proc.on('error', (err) => {
					clearTimeout(timer)
					reject(err)
				})
			})

			// Verify we got a session start event
			const hasSessionStart = events.some(e => 
				(e.type === 'system' && e.subtype === 'init' && e.session_id) ||
				(e.type === 'session_start' && e.session_id)
			)
			expect(hasSessionStart).toBe(true)
		}, TIMEOUT_MS + 5000)

		it('completes simple math and returns answer', async () => {
			let answer: string | null = null
			let proc: ChildProcess | null = null

			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					proc?.kill()
					reject(new Error('Timeout waiting for completion'))
				}, TIMEOUT_MS)

				proc = spawn(DROID_PATH, [
					'exec',
					'--output-format', 'stream-json',
					'--auto', 'high',
					'What is 7 * 8? Reply with just the number, nothing else.',
				], {
					cwd: process.cwd(),
					env: process.env,
					stdio: ['pipe', 'pipe', 'pipe'],
				})

				proc.stdin?.end()

				const rl = createInterface({ input: proc.stdout! })
				
				rl.on('line', (line) => {
					try {
						const event = JSON.parse(line)
						
						// Check for completion event
						if (event.type === 'completion' && event.finalText) {
							answer = event.finalText
							clearTimeout(timer)
							proc?.kill()
							resolve()
						}
					} catch {
						// Non-JSON line, ignore
					}
				})

				proc.on('error', (err) => {
					clearTimeout(timer)
					reject(err)
				})

				proc.on('exit', () => {
					clearTimeout(timer)
					resolve()
				})
			})

			// The answer should contain "56"
			expect(answer).toBeDefined()
			expect(answer).toContain('56')
		}, TIMEOUT_MS + 5000)
	})
})

describe('agent-spawn e2e (skipped - missing deps)', () => {
	it.skipIf(hasDroid && hasApiKeys)('requires droid CLI and API keys', () => {
		console.log(`Droid exists: ${hasDroid}, API keys: ${hasApiKeys}`)
		console.log('Skipping e2e tests - run with ANTHROPIC_API_KEY or OPENAI_API_KEY set')
	})
})
