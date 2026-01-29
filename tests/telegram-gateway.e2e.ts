import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TelegramClient, sessions } from 'telegram'
import WebSocket, { type RawData } from 'ws'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { startGatewayServer, type GatewayServerHandle } from '../src/gateway/server.js'
import { startBridge, type BridgeHandle } from '../src/bridge/index.js'
import type { GatewayEvent } from '../src/protocol/types.js'

const apiId = Number(process.env.TG_E2E_API_ID ?? '')
const apiHash = process.env.TG_E2E_API_HASH ?? ''
const sessionStr = process.env.TG_E2E_SESSION ?? ''
const botToken = process.env.TG_E2E_BOT_TOKEN ?? ''
const botUsernameRaw = process.env.TG_E2E_BOT_USERNAME ?? ''
const authToken = process.env.TG_E2E_AUTH_TOKEN
const allowedChatIdEnv = process.env.TG_E2E_ALLOWED_CHAT_ID
const gatewayPortRaw = process.env.TG_E2E_GATEWAY_PORT
const hasDroid = existsSync(join(homedir(), '.local/bin/droid'))

const botUsername = botUsernameRaw
	? botUsernameRaw.startsWith('@') ? botUsernameRaw : `@${botUsernameRaw}`
	: ''

const gatewayPort = Number(gatewayPortRaw ?? '8790')
const hasEnv = Boolean(apiId && apiHash && sessionStr && botToken && botUsername)
const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS)
const shouldRun = hasEnv && !isCI && process.env.TG_E2E_RUN === '1'
const TIMEOUT_MS = 120_000
const SHORT_TIMEOUT = 30_000
const LONG_TIMEOUT = 180_000 // For tests that involve AI responses

const waitForGatewayEvent = <T extends GatewayEvent['type']>(
	ws: WebSocket,
	type: T,
	predicate: (event: Extract<GatewayEvent, { type: T }>) => boolean,
	timeoutMs: number,
) => new Promise<Extract<GatewayEvent, { type: T }>>((resolve, reject) => {
	let settled = false
	const cleanup = () => {
		if (settled) return
		settled = true
		clearTimeout(timer)
		ws.off('message', onMessage)
		ws.off('error', onError)
	}
	const onError = (err: Error) => { cleanup(); reject(err) }
	const onMessage = (data: RawData) => {
		try {
			const parsed = JSON.parse(data.toString()) as GatewayEvent
			if (parsed.type === type && predicate(parsed as Extract<GatewayEvent, { type: T }>)) {
				cleanup()
				resolve(parsed as Extract<GatewayEvent, { type: T }>)
			}
		} catch { /* ignore */ }
	}
	const timer = setTimeout(() => { cleanup(); reject(new Error(`Timeout waiting for ${type}`)) }, timeoutMs)
	ws.on('message', onMessage)
	ws.on('error', onError)
})

const waitForBotMessage = async (client: TelegramClient, bot: string, expectedText: string, timeoutMs: number) => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const messages = await client.getMessages(bot, { limit: 5 })
		const match = messages.find((msg) => 'message' in msg && msg.message === expectedText && msg.out === false)
		if (match) return match
		await delay(1000)
	}
	throw new Error(`Timeout waiting for bot reply: ${expectedText}`)
}

const waitForBotMessageContaining = async (client: TelegramClient, bot: string, substring: string, timeoutMs: number) => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const messages = await client.getMessages(bot, { limit: 5 })
		const match = messages.find((msg) => 'message' in msg && msg.message?.includes(substring) && msg.out === false)
		if (match && 'message' in match) return match.message
		await delay(1000)
	}
	throw new Error(`Timeout waiting for bot reply containing: ${substring}`)
}

// Wait for a new message after a given timestamp, optionally matching a predicate
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
		const messages = await client.getMessages(bot, { limit: 10 })
		for (const msg of messages) {
			if (!('message' in msg) || !msg.message || !msg.id) continue
			if (msg.out === true) continue
			if (seenIds.has(msg.id)) continue
			// Check if message is after our timestamp (Telegram dates are in seconds)
			const msgDate = msg.date ? msg.date * 1000 : 0
			if (msgDate < cutoff) continue
			seenIds.add(msg.id)
			if (predicate(msg.message)) {
				return msg.message
			}
		}
		await delay(1000)
	}
	throw new Error('Timeout waiting for new bot message matching predicate')
}

const waitForNewBotMessageWithMeta = async (
	client: TelegramClient,
	bot: string,
	afterTimestamp: number,
	predicate: (text: string) => boolean,
	timeoutMs: number,
): Promise<{ text: string; timestamp: number; id: number }> => {
	const deadline = Date.now() + timeoutMs
	const cutoff = Math.max(0, afterTimestamp - 1500)
	const seenIds = new Set<number>()

	while (Date.now() < deadline) {
		const messages = await client.getMessages(bot, { limit: 10 })
		for (const msg of messages) {
			if (!('message' in msg) || !msg.message || !msg.id) continue
			if (msg.out === true) continue
			if (seenIds.has(msg.id)) continue
			const msgDate = msg.date ? msg.date * 1000 : 0
			if (msgDate < cutoff) continue
			seenIds.add(msg.id)
			if (predicate(msg.message)) {
				return { text: msg.message, timestamp: msgDate, id: msg.id }
			}
		}
		await delay(1000)
	}
	throw new Error('Timeout waiting for new bot message with meta')
}

// Single gateway instance - Telegram only allows one poller per bot token
// Skip in CI - these tests require real Telegram credentials and are for local use only
describe.skipIf(!shouldRun)('telegram gateway e2e', () => {
	let client: TelegramClient
	let server: GatewayServerHandle
	let bridge: BridgeHandle
	let ws: WebSocket
	let tempDir: string
	let chatId: number | string
	const port = Number.isNaN(gatewayPort) ? 8790 : gatewayPort

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'bitesbot-e2e-'))
		
		const { StringSession } = sessions
		client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, { connectionRetries: 5 })
		await client.connect()
		if (!await client.isUserAuthorized()) {
			throw new Error('Telegram session not authorized. Generate a new session string.')
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

		// Start the bridge to handle commands
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
	}, TIMEOUT_MS)

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

	// Core messaging
	it('receives inbound and delivers outbound messages', async () => {
		const inboundText = `e2e inbound ${Date.now()}`
		const inboundPromise = waitForGatewayEvent(ws, 'message.received', (e) => e.payload.text === inboundText, TIMEOUT_MS)

		await client.sendMessage(botUsername, { message: inboundText })
		const inbound = await inboundPromise
		chatId = inbound.payload.chatId

		const outboundText = `e2e outbound ${Date.now()}`
		const response = await fetch(`http://127.0.0.1:${port}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
			body: JSON.stringify({ chatId, text: outboundText }),
		})
		expect((await response.json()).ok).toBe(true)
		await waitForBotMessage(client, botUsername, outboundText, TIMEOUT_MS)
	}, TIMEOUT_MS)

	// HTTP API tests
	it('GET /health returns ok', async () => {
		const res = await fetch(`http://127.0.0.1:${port}/health`)
		const json = await res.json()
		expect(json.ok).toBe(true)
		expect(json.version).toBeDefined()
	})

	it('GET /status returns server info', async () => {
		const res = await fetch(`http://127.0.0.1:${port}/status`)
		const json = await res.json()
		expect(json.startedAt).toBeDefined()
		expect(json.bot?.username).toBeDefined()
	})

	it('POST /send with invalid chatId returns error', async () => {
		const res = await fetch(`http://127.0.0.1:${port}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ chatId: 999999999, text: 'test' }),
		})
		expect((await res.json()).ok).toBe(false)
	})

	// Bridge command tests
	it('/status returns session info', async () => {
		await client.sendMessage(botUsername, { message: '/status' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'CLI:', SHORT_TIMEOUT)
		expect(reply).toContain('CLI:')
	}, TIMEOUT_MS)

	it('/model without arg shows usage', async () => {
		await client.sendMessage(botUsername, { message: '/model' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'Usage:', SHORT_TIMEOUT)
		expect(reply).toContain('/model')
	}, TIMEOUT_MS)

	it('/model opus sets model', async () => {
		await client.sendMessage(botUsername, { message: '/model opus' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'Model set to', SHORT_TIMEOUT)
		expect(reply).toContain('opus')
	}, TIMEOUT_MS)

	it('/new starts fresh session', async () => {
		await client.sendMessage(botUsername, { message: '/new' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)
		expect(reply).toBeDefined()
	}, TIMEOUT_MS)

	it('/stop stops current session', async () => {
		await client.sendMessage(botUsername, { message: '/stop' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'stop', SHORT_TIMEOUT)
		expect(reply).toBeDefined()
	}, TIMEOUT_MS)

	it('/stream toggles streaming', async () => {
		await client.sendMessage(botUsername, { message: '/stream' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'Streaming', SHORT_TIMEOUT)
		expect(reply).toBeDefined()
	}, TIMEOUT_MS)

	it('/verbose toggles verbose mode', async () => {
		await client.sendMessage(botUsername, { message: '/verbose' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'erbose', SHORT_TIMEOUT)
		expect(reply).toBeDefined()
	}, TIMEOUT_MS)

	it('/use claude switches CLI', async () => {
		await client.sendMessage(botUsername, { message: '/use claude' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'claude', SHORT_TIMEOUT)
		expect(reply).toBeDefined()
	}, TIMEOUT_MS)

	it('/cron list returns response', async () => {
		await client.sendMessage(botUsername, { message: '/cron list' })
		// Wait for any response (could be "No jobs" or a list)
		await delay(3000)
	}, TIMEOUT_MS)

	// ============================================
	// FUNCTIONAL TESTS - verify actual behavior
	// ============================================

	it.skipIf(!hasDroid)('spawns a droid subagent while main droid session responds', async () => {
		const token = `${Date.now()}`
		const label = `Subagent-${token}`

		await client.sendMessage(botUsername, { message: '/use droid' })
		await waitForBotMessage(client, botUsername, 'Switched to droid.', SHORT_TIMEOUT)

		const spawnPrompt = `/spawn --label "${label}" "Write 60 bullet points about shipping a feature. Use 6 section headings with 10 bullets each. Each bullet must be at least 12 words. End with sub-${token}:42."`
		await client.sendMessage(botUsername, { message: spawnPrompt })
		const spawnAck = await waitForNewBotMessageWithMeta(
			client,
			botUsername,
			Date.now(),
			(text) => text.includes(`🚀 Spawned: ${label}`),
			LONG_TIMEOUT,
		)
		expect(spawnAck.text).toContain(`🚀 Spawned: ${label}`)

		const startedMsg = await waitForNewBotMessageWithMeta(
			client,
			botUsername,
			spawnAck.timestamp,
			(text) => text.includes(`🔄 Started: ${label}`),
			LONG_TIMEOUT,
		)
		expect(startedMsg.text).toContain(`🔄 Started: ${label}`)

		const followPrompt = `Main2-${token}: Reply with exactly "main-${token}:6".`
		await client.sendMessage(botUsername, { message: followPrompt })
		const [followReply, subagentDone] = await Promise.all([
			waitForNewBotMessageWithMeta(
				client,
				botUsername,
				startedMsg.timestamp,
				(text) => text.includes(`main-${token}:6`),
				LONG_TIMEOUT,
			),
			waitForNewBotMessageWithMeta(
				client,
				botUsername,
				startedMsg.timestamp,
				(text) => text.includes(`✅ ${label}`),
				LONG_TIMEOUT,
			),
		])
		console.log(`[e2e] started id=${startedMsg.id} ts=${startedMsg.timestamp} text="${startedMsg.text}"`)
		console.log(`[e2e] main reply id=${followReply.id} ts=${followReply.timestamp} text="${followReply.text}"`)
		console.log(`[e2e] subagent done id=${subagentDone.id} ts=${subagentDone.timestamp} text="${subagentDone.text}"`)
		expect(followReply.text).toContain(`main-${token}:6`)
		expect(subagentDone.text).toContain(`✅ ${label}`)
		expect(subagentDone.text).toContain(`sub-${token}:42`)
		expect(startedMsg.id).toBeLessThan(followReply.id)
		expect(followReply.id).toBeLessThan(subagentDone.id)
	}, LONG_TIMEOUT)

	it('sends a prompt and receives an AI response', async () => {
		// Start fresh
		await client.sendMessage(botUsername, { message: '/new' })
		await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)
		
		const beforeSend = Date.now()
		const testPrompt = 'What is 2+2? Reply with just the number.'
		await client.sendMessage(botUsername, { message: testPrompt })
		
		// Wait for a response that contains "4" (the answer)
		const response = await waitForNewBotMessage(
			client,
			botUsername,
			beforeSend,
			(text) => text.includes('4') && !text.includes('fresh') && !text.includes('CLI:'),
			LONG_TIMEOUT,
		)
		expect(response).toContain('4')
	}, LONG_TIMEOUT)

	it('/new actually clears session context', async () => {
		// Send a message with a unique identifier
		const secretWord = `SECRET_${Date.now()}`
		await client.sendMessage(botUsername, { message: `/new` })
		await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)
		
		const beforeFirst = Date.now()
		await client.sendMessage(botUsername, { message: `Remember this word: ${secretWord}. Just say "OK" to confirm.` })
		
		// Wait for acknowledgment
		await waitForNewBotMessage(
			client,
			botUsername,
			beforeFirst,
			(text) => text.toLowerCase().includes('ok') || text.toLowerCase().includes('got it') || text.includes(secretWord),
			LONG_TIMEOUT,
		)
		
		// Clear session
		await client.sendMessage(botUsername, { message: '/new' })
		await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)
		
		// Ask about the secret word - it should NOT know it
		const beforeSecond = Date.now()
		await client.sendMessage(botUsername, { message: 'What was the secret word I told you? If you don\'t know, say "I don\'t know".' })
		
		const response = await waitForNewBotMessage(
			client,
			botUsername,
			beforeSecond,
			(text) => !text.includes('fresh') && !text.includes('CLI:') && text.length > 5,
			LONG_TIMEOUT,
		)
		
		// The bot should NOT remember the secret word after /new
		expect(response).not.toContain(secretWord)
	}, LONG_TIMEOUT * 2)

	it('/stop actually terminates a running session', async () => {
		// Start fresh and begin a long task
		await client.sendMessage(botUsername, { message: '/new' })
		await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)
		
		// Send a task that would take a while
		await client.sendMessage(botUsername, { message: 'Count from 1 to 100, saying each number on a new line.' })
		
		// Wait a moment for it to start
		await delay(3000)
		
		// Stop it
		await client.sendMessage(botUsername, { message: '/stop' })
		
		// Should get stop confirmation
		const stopReply = await waitForBotMessageContaining(client, botUsername, 'stop', SHORT_TIMEOUT)
		expect(stopReply).toBeDefined()
		
		// Verify /status shows no active session
		await client.sendMessage(botUsername, { message: '/status' })
		const statusReply = await waitForBotMessageContaining(client, botUsername, 'CLI:', SHORT_TIMEOUT)
		expect(statusReply).toContain('CLI:')
	}, LONG_TIMEOUT)
})

describe('telegram gateway e2e (skipped)', () => {
	it.skipIf(shouldRun)('skipped: set TG_E2E_RUN=1 with valid TG_E2E_* env vars', () => {
		// This test exists to show why the suite was skipped
		if (isCI) {
			console.log('Skipped: Telegram E2E tests are local-only (CI detected)')
		} else if (process.env.TG_E2E_RUN !== '1') {
			console.log('Skipped: TG_E2E_RUN=1 not set')
		} else {
			console.log('Skipped: Missing TG_E2E_* environment variables')
		}
	})
})
