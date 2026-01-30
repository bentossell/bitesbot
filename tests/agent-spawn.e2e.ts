import { describe, it, expect } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DROID_PATH = join(homedir(), '.local/bin/droid')
const TIMEOUT_MS = 60_000

const hasDroid = existsSync(DROID_PATH)
const hasCodex = (() => {
	try {
		const result = spawnSync('which', ['codex'])
		return result.status === 0
	} catch {
		return false
	}
})()
const hasPi = (() => {
	try {
		const result = spawnSync('which', ['pi'])
		return result.status === 0
	} catch {
		return false
	}
})()
describe.skipIf(!hasDroid)('agent-spawn e2e', () => {
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

describe.skipIf(!hasCodex)('codex CLI e2e', () => {
	it('spawns and receives thread.started event', async () => {
		const events: Record<string, unknown>[] = []
		let proc: ChildProcess | null = null

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				proc?.kill()
				reject(new Error('Timeout waiting for thread.started'))
			}, TIMEOUT_MS)

			proc = spawn('codex', [
				'exec',
				'--json',
				'--dangerously-bypass-approvals-and-sandbox',
				'--skip-git-repo-check',
				'-C', '/tmp',
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
					
					// Check for thread start
					if (event.type === 'thread.started' && event.thread_id) {
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

		// Verify we got a thread.started event
		const hasThreadStart = events.some(e => e.type === 'thread.started' && e.thread_id)
		expect(hasThreadStart).toBe(true)
	}, TIMEOUT_MS + 5000)

	it('completes simple math and returns answer via item.completed', async () => {
		let answer: string | null = null
		let proc: ChildProcess | null = null

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				proc?.kill()
				reject(new Error('Timeout waiting for item.completed'))
			}, TIMEOUT_MS)

			proc = spawn('codex', [
				'exec',
				'--json',
				'--dangerously-bypass-approvals-and-sandbox',
				'--skip-git-repo-check',
				'-C', '/tmp',
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
					
					// Check for item.completed with agent_message
					if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
						answer = event.item.text
					}
					// turn.completed signals the end
					if (event.type === 'turn.completed') {
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

describe.skipIf(!hasPi)('pi CLI e2e', () => {
	it('spawns and receives session header', async () => {
		const events: Record<string, unknown>[] = []
		let proc: ChildProcess | null = null

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				proc?.kill()
				reject(new Error('Timeout waiting for session header'))
			}, TIMEOUT_MS)

			proc = spawn('pi', [
				'--mode', 'json',
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
					if (event.type === 'session' && event.id) {
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

		const hasSession = events.some(e => e.type === 'session' && e.id)
		expect(hasSession).toBe(true)
	}, TIMEOUT_MS + 5000)

	it('completes simple math and returns answer', async () => {
		let answer = ''
		let proc: ChildProcess | null = null

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				proc?.kill()
				reject(new Error('Timeout waiting for turn_end'))
			}, TIMEOUT_MS)

			proc = spawn('pi', [
				'--mode', 'json',
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
					if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
						answer += String(event.assistantMessageEvent.delta ?? '')
					}
					if (event.type === 'turn_end') {
						const content = event.message?.content
						if (Array.isArray(content)) {
							const text = content
								.filter((block: { type?: string; text?: string }) => block.type === 'text')
								.map((block: { text?: string }) => block.text ?? '')
								.join('')
							if (text) answer = text
						}
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

		expect(answer).toBeDefined()
		expect(answer).toContain('56')
	}, TIMEOUT_MS + 5000)
})

describe('agent-spawn e2e (skipped - missing deps)', () => {
	it.skipIf(hasDroid)('requires droid CLI', () => {
		console.log(`Droid exists: ${hasDroid}`)
		console.log('Skipping e2e tests - install droid CLI at ~/.local/bin/droid')
	})
	it.skipIf(hasCodex)('requires codex CLI', () => {
		console.log(`Codex exists: ${hasCodex}`)
		console.log('Skipping codex e2e tests - install codex CLI')
	})
	it.skipIf(hasPi)('requires pi CLI', () => {
		console.log(`Pi exists: ${hasPi}`)
		console.log('Skipping pi e2e tests - install pi CLI')
	})
})
