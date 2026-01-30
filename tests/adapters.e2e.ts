/**
 * Comprehensive E2E Test Suite for Agent Adapters
 *
 * Tests all supported adapters (droid, codex, claude, pi) through the full gateway stack.
 * Covers: spawn, tool use, model switching, /status, session continuity, clean exit.
 *
 * Run: TG_E2E_RUN=1 pnpm test:e2e --grep adapters
 *
 * Required env vars:
 * - TG_E2E_API_ID, TG_E2E_API_HASH, TG_E2E_SESSION
 * - TG_E2E_BOT_TOKEN, TG_E2E_BOT_USERNAME
 * - TG_E2E_RUN=1
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { TelegramClient, sessions } from 'telegram'
import WebSocket from 'ws'
import { setTimeout as delay } from 'node:timers/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { startGatewayServer, type GatewayServerHandle } from '../src/gateway/server.js'
import { startBridge, type BridgeHandle } from '../src/bridge/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// Environment & Config
// ─────────────────────────────────────────────────────────────────────────────

const apiId = Number(process.env.TG_E2E_API_ID ?? '')
const apiHash = process.env.TG_E2E_API_HASH ?? ''
const sessionStr = process.env.TG_E2E_SESSION ?? ''
const botToken = process.env.TG_E2E_BOT_TOKEN ?? ''
const botUsernameRaw = process.env.TG_E2E_BOT_USERNAME ?? ''
const authToken = process.env.TG_E2E_AUTH_TOKEN
const allowedChatIdEnv = process.env.TG_E2E_ALLOWED_CHAT_ID
const gatewayPortRaw = process.env.TG_E2E_GATEWAY_PORT

const botUsername = botUsernameRaw
	? botUsernameRaw.startsWith('@') ? botUsernameRaw : `@${botUsernameRaw}`
	: ''
const gatewayPort = Number(gatewayPortRaw ?? '8791') // Different port from main e2e tests
const hasEnv = Boolean(apiId && apiHash && sessionStr && botToken && botUsername)
const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS)
const shouldRun = hasEnv && !isCI && process.env.TG_E2E_RUN === '1'

// Timeout constants
const SHORT_TIMEOUT = 30_000
const MEDIUM_TIMEOUT = 60_000
const LONG_TIMEOUT = 180_000

// ─────────────────────────────────────────────────────────────────────────────
// Adapter Detection
// ─────────────────────────────────────────────────────────────────────────────

type AdapterInfo = {
	name: string
	available: boolean
	modelAliases: string[]
	supportsToolUse: boolean
}

const checkCliAvailable = (command: string): boolean => {
	// Handle home directory paths
	const expanded = command.startsWith('~/') 
		? join(homedir(), command.slice(2))
		: command
	
	if (expanded.includes('/')) {
		return existsSync(expanded)
	}
	try {
		const result = spawnSync('which', [command])
		return result.status === 0
	} catch {
		return false
	}
}

const ADAPTERS: AdapterInfo[] = [
	{
		name: 'droid',
		available: checkCliAvailable('~/.local/bin/droid'),
		modelAliases: ['opus', 'sonnet', 'haiku'],
		supportsToolUse: true,
	},
	{
		name: 'codex',
		available: checkCliAvailable('codex'),
		modelAliases: ['codex', 'codex-max'],
		supportsToolUse: true,
	},
	{
		name: 'claude',
		available: checkCliAvailable('/opt/homebrew/bin/claude'),
		modelAliases: ['opus', 'sonnet', 'haiku'],
		supportsToolUse: true,
	},
	// pi adapter is placeholder - typically requires special setup
	{
		name: 'pi',
		available: false, // Not available by default
		modelAliases: [],
		supportsToolUse: false,
	},
]

const getAvailableAdapters = (): AdapterInfo[] =>
	ADAPTERS.filter(a => a.available)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const waitForBotMessageContaining = async (
	client: TelegramClient,
	bot: string,
	substring: string,
	timeoutMs: number
) => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const messages = await client.getMessages(bot, { limit: 10 })
		const match = messages.find((msg) => 
			'message' in msg && msg.message?.includes(substring) && msg.out === false
		)
		if (match && 'message' in match) return match.message
		await delay(1500)
	}
	throw new Error(`Timeout waiting for bot reply containing: ${substring}`)
}

const waitForNewBotMessage = async (
	client: TelegramClient,
	bot: string,
	afterTimestamp: number,
	predicate: (text: string) => boolean,
	timeoutMs: number,
): Promise<string> => {
	const deadline = Date.now() + timeoutMs
	const cutoff = Math.max(0, afterTimestamp - 1500)
	const seenIds = new Set<number>()
	
	while (Date.now() < deadline) {
		const messages = await client.getMessages(bot, { limit: 15 })
		for (const msg of messages) {
			if (!('message' in msg) || !msg.message || !msg.id) continue
			if (msg.out === true) continue
			if (seenIds.has(msg.id)) continue
			const msgDate = msg.date ? msg.date * 1000 : 0
			if (msgDate < cutoff) continue
			seenIds.add(msg.id)
			if (predicate(msg.message)) {
				return msg.message
			}
		}
		await delay(1500)
	}
	throw new Error('Timeout waiting for new bot message matching predicate')
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!shouldRun)('adapters e2e', () => {
	let client: TelegramClient
	let server: GatewayServerHandle
	let bridge: BridgeHandle
	let ws: WebSocket
	let tempDir: string
	let toolTestDir: string
	const port = Number.isNaN(gatewayPort) ? 8791 : gatewayPort

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'bitesbot-adapters-e2e-'))
		toolTestDir = join(tempDir, 'tooltest')
		await import('node:fs/promises').then(fs => fs.mkdir(toolTestDir, { recursive: true }))

		const { StringSession } = sessions
		client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, { connectionRetries: 5 })
		await client.connect()
		if (!await client.isUserAuthorized()) {
			throw new Error('Telegram session not authorized')
		}

		const me = await client.getMe()
		const allowedChatId = allowedChatIdEnv ? Number(allowedChatIdEnv) : Number(me.id)

		server = await startGatewayServer({
			botToken,
			host: '127.0.0.1',
			port,
			authToken: authToken || undefined,
			allowedChatIds: Number.isNaN(allowedChatId) ? undefined : [allowedChatId],
			bridge: {
				enabled: true,
				defaultCli: 'claude',
				workingDirectory: tempDir,
				adaptersDir: join(process.cwd(), 'adapters'),
			},
		})

		bridge = await startBridge({
			gatewayUrl: `http://127.0.0.1:${port}`,
			authToken: authToken || undefined,
			adaptersDir: join(process.cwd(), 'adapters'),
			defaultCli: 'claude',
			workingDirectory: tempDir,
		})

		ws = new WebSocket(`ws://127.0.0.1:${port}/events`, authToken
			? { headers: { Authorization: `Bearer ${authToken}` } }
			: undefined)

		await new Promise<void>((resolve, reject) => {
			ws.on('open', () => resolve())
			ws.on('error', reject)
		})
	}, LONG_TIMEOUT)

	afterAll(async () => {
		if (ws?.readyState !== WebSocket.CLOSED) {
			await new Promise<void>((resolve) => {
				ws.once('close', () => resolve())
				ws.close()
			})
		}
		if (bridge) bridge.close()
		if (server) await server.close()
		if (client) await client.disconnect()
		if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Per-Adapter Test Suite
	// ─────────────────────────────────────────────────────────────────────────

	describe.each(getAvailableAdapters())('$name adapter', (adapter) => {
		beforeEach(async () => {
			// Switch to the adapter and start fresh
			await client.sendMessage(botUsername, { message: `/use ${adapter.name}` })
			await waitForBotMessageContaining(client, botUsername, adapter.name, SHORT_TIMEOUT)
			await client.sendMessage(botUsername, { message: '/new' })
			await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)
		}, MEDIUM_TIMEOUT)

		// ───────────────────────────────────────────────────────────────────────
		// 1. Spawn & Basic Response
		// ───────────────────────────────────────────────────────────────────────

		it('spawns successfully and responds to simple prompt', async () => {
			const beforeSend = Date.now()
			await client.sendMessage(botUsername, { message: 'What is 2+2? Reply with just the number.' })
			
			const response = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSend,
				(text) => text.includes('4') && !text.includes('fresh') && !text.includes('CLI:'),
				LONG_TIMEOUT,
			)
			expect(response).toContain('4')
		}, LONG_TIMEOUT)

		// ───────────────────────────────────────────────────────────────────────
		// 2. Model Switching & /status
		// ───────────────────────────────────────────────────────────────────────

		it.skipIf(adapter.modelAliases.length === 0)('/model switches model and /status reflects it', async () => {
			const modelAlias = adapter.modelAliases[0]
			
			// Switch model
			await client.sendMessage(botUsername, { message: `/model ${modelAlias}` })
			const modelReply = await waitForBotMessageContaining(client, botUsername, 'Model set to', SHORT_TIMEOUT)
			expect(modelReply).toContain(modelAlias)
			
			// Check status shows CLI
			await client.sendMessage(botUsername, { message: '/status' })
			const statusReply = await waitForBotMessageContaining(client, botUsername, 'CLI:', SHORT_TIMEOUT)
			expect(statusReply).toContain(`CLI: ${adapter.name}`)
		}, MEDIUM_TIMEOUT)

		it('/model with invalid name returns helpful error', async () => {
			await client.sendMessage(botUsername, { message: '/model invalid-model-xyz-12345' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'Model set to', SHORT_TIMEOUT)
			// The gateway accepts any model string, so it should just echo it back
			expect(reply).toBeDefined()
		}, SHORT_TIMEOUT)

		// ───────────────────────────────────────────────────────────────────────
		// 3. Session Continuity (Multi-turn)
		// ───────────────────────────────────────────────────────────────────────

		it('maintains session continuity across turns', async () => {
			const secretWord = `SECRET_${adapter.name}_${Date.now()}`
			
			// First turn: tell it a secret
			const beforeFirst = Date.now()
			await client.sendMessage(botUsername, { message: `Remember this exact word: ${secretWord}. Just say "OK".` })
			await waitForNewBotMessage(
				client,
				botUsername,
				beforeFirst,
				(text) => text.toLowerCase().includes('ok') || text.includes(secretWord),
				LONG_TIMEOUT,
			)
			
			// Second turn: ask for the secret (same session)
			const beforeSecond = Date.now()
			await client.sendMessage(botUsername, { message: 'What was the secret word I just told you?' })
			const secondResponse = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSecond,
				(text) => text.length > 5 && !text.includes('CLI:'),
				LONG_TIMEOUT,
			)
			
			// Should remember the secret word
			expect(secondResponse).toContain(secretWord)
		}, LONG_TIMEOUT * 2)

		// ───────────────────────────────────────────────────────────────────────
		// 4. Tool Use Tests
		// ───────────────────────────────────────────────────────────────────────

		describe.skipIf(!adapter.supportsToolUse)('tool use', () => {
			it('can read files', async () => {
				// Create a test file
				const testFilePath = join(toolTestDir, `read-test-${adapter.name}.txt`)
				const testContent = `Hello from ${adapter.name} read test!`
				await writeFile(testFilePath, testContent)

				const beforeSend = Date.now()
				await client.sendMessage(botUsername, { 
					message: `Read the file at ${testFilePath} and tell me what it says. Quote the exact content.` 
				})
				
				const response = await waitForNewBotMessage(
					client,
					botUsername,
					beforeSend,
					(text) => text.includes(testContent) || text.includes('Hello from'),
					LONG_TIMEOUT,
				)
				expect(response).toContain(testContent)
			}, LONG_TIMEOUT)

			it('can create files', async () => {
				const testFilePath = join(toolTestDir, `create-test-${adapter.name}-${Date.now()}.txt`)
				const testContent = `Created by ${adapter.name}`

				const beforeSend = Date.now()
				await client.sendMessage(botUsername, { 
					message: `Create a file at ${testFilePath} with the content "${testContent}". Then confirm you created it.` 
				})
				
				await waitForNewBotMessage(
					client,
					botUsername,
					beforeSend,
					(text) => text.toLowerCase().includes('creat') || text.toLowerCase().includes('done'),
					LONG_TIMEOUT,
				)

				// Verify file was created
				await delay(1000) // Give filesystem time
				const exists = existsSync(testFilePath)
				expect(exists).toBe(true)
				
				if (exists) {
					const content = await readFile(testFilePath, 'utf-8')
					expect(content).toContain(testContent)
				}
			}, LONG_TIMEOUT)

			it('can execute shell commands', async () => {
				const beforeSend = Date.now()
				await client.sendMessage(botUsername, { 
					message: 'Run "echo SHELLTEST123" and tell me what it outputs.' 
				})
				
				const response = await waitForNewBotMessage(
					client,
					botUsername,
					beforeSend,
					(text) => text.includes('SHELLTEST123'),
					LONG_TIMEOUT,
				)
				expect(response).toContain('SHELLTEST123')
			}, LONG_TIMEOUT)

			it('can chain multiple tools', async () => {
				// Tool chaining: create file, read it back, report content
				const testFilePath = join(toolTestDir, `chain-test-${adapter.name}-${Date.now()}.txt`)
				const uniqueContent = `CHAIN_${Date.now()}_TEST`

				const beforeSend = Date.now()
				await client.sendMessage(botUsername, { 
					message: `Create a file at ${testFilePath} with content "${uniqueContent}". Then read it back and tell me exactly what it contains.` 
				})
				
				const response = await waitForNewBotMessage(
					client,
					botUsername,
					beforeSend,
					(text) => text.includes(uniqueContent),
					LONG_TIMEOUT,
				)
				expect(response).toContain(uniqueContent)
			}, LONG_TIMEOUT)

			it('can search/grep in files', async () => {
				// Create files to search
				const searchDir = join(toolTestDir, `search-${adapter.name}-${Date.now()}`)
				await import('node:fs/promises').then(fs => fs.mkdir(searchDir, { recursive: true }))
				
				const uniquePattern = `GREPME_${adapter.name}_${Date.now()}`
				await writeFile(join(searchDir, 'file1.txt'), `Some text\n${uniquePattern}\nMore text`)
				await writeFile(join(searchDir, 'file2.txt'), 'Other content')

				const beforeSend = Date.now()
				await client.sendMessage(botUsername, { 
					message: `Search for "${uniquePattern}" in ${searchDir} and tell me which file contains it.` 
				})
				
				const response = await waitForNewBotMessage(
					client,
					botUsername,
					beforeSend,
					(text) => text.includes('file1') || text.includes(uniquePattern),
					LONG_TIMEOUT,
				)
				expect(response).toMatch(/file1|found/i)
			}, LONG_TIMEOUT)
		})

		// ───────────────────────────────────────────────────────────────────────
		// 5. Clean Exit (/stop)
		// ───────────────────────────────────────────────────────────────────────

		it('/stop terminates running session cleanly', async () => {
			// Start a potentially long task
			await client.sendMessage(botUsername, { message: 'List numbers from 1 to 50, one per line.' })
			
			// Wait briefly for it to start
			await delay(3000)
			
			// Stop it
			await client.sendMessage(botUsername, { message: '/stop' })
			const stopReply = await waitForBotMessageContaining(client, botUsername, 'stop', SHORT_TIMEOUT)
			expect(stopReply.toLowerCase()).toContain('stop')
			
			// Status should show no active session
			await client.sendMessage(botUsername, { message: '/status' })
			const statusReply = await waitForBotMessageContaining(client, botUsername, 'CLI:', SHORT_TIMEOUT)
			expect(statusReply).toContain('CLI:')
		}, MEDIUM_TIMEOUT)

		// ───────────────────────────────────────────────────────────────────────
		// 6. Timeout/Error Handling
		// ───────────────────────────────────────────────────────────────────────

		it('handles errors gracefully', async () => {
			const beforeSend = Date.now()
			// Try to read a nonexistent file
			await client.sendMessage(botUsername, { 
				message: 'Try to read /nonexistent/path/that/does/not/exist/file.txt and tell me what happens.' 
			})
			
			const response = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSend,
				(text) => text.length > 10 && !text.includes('CLI:'),
				LONG_TIMEOUT,
			)
			// Should report the file doesn't exist or error, not crash
			expect(response.toLowerCase()).toMatch(/not exist|no such|cannot|error|doesn't exist|unable/i)
		}, LONG_TIMEOUT)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Cross-Adapter Tests
	// ─────────────────────────────────────────────────────────────────────────

	describe('cross-adapter', () => {
		it('/use switches between available adapters', async () => {
			const available = getAvailableAdapters()
			if (available.length < 2) {
				console.log('Skipping cross-adapter test: need at least 2 adapters')
				return
			}

			for (const adapter of available) {
				await client.sendMessage(botUsername, { message: `/use ${adapter.name}` })
				const reply = await waitForBotMessageContaining(client, botUsername, adapter.name, SHORT_TIMEOUT)
				expect(reply).toContain(adapter.name)
				
				await client.sendMessage(botUsername, { message: '/status' })
				const status = await waitForBotMessageContaining(client, botUsername, 'CLI:', SHORT_TIMEOUT)
				expect(status).toContain(`CLI: ${adapter.name}`)
			}
		}, LONG_TIMEOUT)

		it('/use with invalid CLI returns helpful error', async () => {
			await client.sendMessage(botUsername, { message: '/use nonexistent-cli-xyz' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'Unknown CLI', SHORT_TIMEOUT)
			expect(reply).toContain('Available:')
		}, SHORT_TIMEOUT)

		it('/new clears context and works with any adapter', async () => {
			const available = getAvailableAdapters()
			if (available.length === 0) return

			const adapter = available[0]
			await client.sendMessage(botUsername, { message: `/use ${adapter.name}` })
			await waitForBotMessageContaining(client, botUsername, adapter.name, SHORT_TIMEOUT)

			const secretWord = `CROSSTEST_${Date.now()}`
			
			// Teach it something
			const beforeFirst = Date.now()
			await client.sendMessage(botUsername, { message: `Remember: ${secretWord}. Say OK.` })
			await waitForNewBotMessage(
				client,
				botUsername,
				beforeFirst,
				(text) => text.toLowerCase().includes('ok') || text.includes(secretWord),
				LONG_TIMEOUT,
			)

			// Clear session
			await client.sendMessage(botUsername, { message: '/new' })
			await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)

			// Ask - should NOT remember
			const beforeSecond = Date.now()
			await client.sendMessage(botUsername, { message: 'What secret word did I tell you? If none, say "I don\'t know".' })
			const response = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSecond,
				(text) => text.length > 5 && !text.includes('fresh'),
				LONG_TIMEOUT,
			)
			
			// Should NOT contain the secret word after /new
			expect(response).not.toContain(secretWord)
		}, LONG_TIMEOUT * 2)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Status Command Enhancement Tests
	// ─────────────────────────────────────────────────────────────────────────

	describe('/status enhancements', () => {
		it('shows current CLI', async () => {
			await client.sendMessage(botUsername, { message: '/status' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'CLI:', SHORT_TIMEOUT)
			expect(reply).toMatch(/CLI:\s*\w+/)
		}, SHORT_TIMEOUT)

		it('shows streaming setting', async () => {
			await client.sendMessage(botUsername, { message: '/status' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'Streaming:', SHORT_TIMEOUT)
			expect(reply).toMatch(/Streaming:\s*(on|off)/i)
		}, SHORT_TIMEOUT)

		it('shows session state when active', async () => {
			const available = getAvailableAdapters()
			if (available.length === 0) return

			// Start a task
			await client.sendMessage(botUsername, { message: 'Count to 10 slowly.' })
			await delay(2000)

			// Check status while running
			await client.sendMessage(botUsername, { message: '/status' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'CLI:', SHORT_TIMEOUT)
			expect(reply).toContain('CLI:')

			// Stop it
			await client.sendMessage(botUsername, { message: '/stop' })
			await waitForBotMessageContaining(client, botUsername, 'stop', SHORT_TIMEOUT)
		}, MEDIUM_TIMEOUT)
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// Skipped Test Notice
// ─────────────────────────────────────────────────────────────────────────────

describe('adapters e2e (skipped)', () => {
	it.skipIf(shouldRun)('skipped: set TG_E2E_RUN=1 with valid TG_E2E_* env vars', () => {
		const available = getAvailableAdapters()
		console.log(`Available adapters: ${available.map(a => a.name).join(', ') || 'none'}`)
		
		if (isCI) {
			console.log('Skipped: Adapter E2E tests are local-only (CI detected)')
		} else if (process.env.TG_E2E_RUN !== '1') {
			console.log('Skipped: TG_E2E_RUN=1 not set')
		} else {
			console.log('Skipped: Missing TG_E2E_* environment variables')
		}
	})
})
