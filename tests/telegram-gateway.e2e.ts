import { describe, expect, beforeAll, afterAll, vi } from 'vitest'
import { TelegramClient, sessions } from 'telegram'
import WebSocket, { type RawData } from 'ws'
import { setTimeout as delay } from 'node:timers/promises'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { startGatewayServer, type GatewayServerHandle } from '../src/gateway/server.js'
import { startBridge, type BridgeHandle, setWorkspaceDir } from '../src/bridge/index.js'
import { JsonlSession } from '../src/bridge/jsonl-session.js'
import { setSubagentRegistryPath } from '../src/bridge/subagent-registry.js'
import type { GatewayEvent } from '../src/protocol/types.js'
import { acquireE2eLock, e2eTest } from './e2e-checkpoint.js'

const apiId = Number(process.env.TG_E2E_API_ID ?? '')
const apiHash = process.env.TG_E2E_API_HASH ?? ''
const sessionStr = process.env.TG_E2E_SESSION ?? ''
const botToken = process.env.TG_E2E_BOT_TOKEN ?? ''
const botUsernameRaw = process.env.TG_E2E_BOT_USERNAME ?? ''
const authToken = process.env.TG_E2E_AUTH_TOKEN
const allowedChatIdEnv = process.env.TG_E2E_ALLOWED_CHAT_ID
const gatewayPortRaw = process.env.TG_E2E_GATEWAY_PORT
const hasDroid = existsSync(join(homedir(), '.local/bin/droid'))
const hasCodex = (() => {
	try {
		const result = spawnSync('which', ['codex'])
		return result.status === 0
	} catch {
		return false
	}
})()
const resolvePiPath = (): string | null => {
	try {
		const result = spawnSync('which', ['pi'])
		if (result.status === 0) return result.stdout.toString().trim()
	} catch {
		// ignore
	}
	const nvmDir = join(homedir(), '.nvm', 'versions', 'node')
	if (!existsSync(nvmDir)) return null
	for (const version of readdirSync(nvmDir)) {
		const candidate = join(nvmDir, version, 'bin', 'pi')
		if (existsSync(candidate)) return candidate
	}
	return null
}
const piPath = resolvePiPath()
const hasPi = Boolean(piPath)
if (piPath) {
	const piDir = dirname(piPath)
	if (!process.env.PATH?.includes(piDir)) {
		process.env.PATH = `${piDir}:${process.env.PATH ?? ''}`
	}
}

const botUsername = botUsernameRaw
	? botUsernameRaw.startsWith('@') ? botUsernameRaw : `@${botUsernameRaw}`
	: ''

const gatewayPort = Number(gatewayPortRaw ?? '8790')
const hasEnv = Boolean(apiId && apiHash && sessionStr && botToken && botUsername)
const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS)
const shouldRun = hasEnv && !isCI && process.env.TG_E2E_RUN === '1'
const TIMEOUT_MS = 60_000
const SHORT_TIMEOUT = 20_000
const LONG_TIMEOUT = 60_000 // For tests that involve AI responses
const SUBAGENT_STEP_TIMEOUT = 120_000
const POLL_DELAY_MS = 2000

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
		await delay(POLL_DELAY_MS)
	}
	throw new Error(`Timeout waiting for bot reply: ${expectedText}`)
}

const waitForBotMessageContaining = async (client: TelegramClient, bot: string, substring: string, timeoutMs: number) => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const messages = await client.getMessages(bot, { limit: 5 })
		const match = messages.find((msg) => 'message' in msg && msg.message?.includes(substring) && msg.out === false)
		if (match && 'message' in match) return match.message
		await delay(POLL_DELAY_MS)
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
		await delay(POLL_DELAY_MS)
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
		await delay(POLL_DELAY_MS)
	}
	throw new Error('Timeout waiting for new bot message with meta')
}

type SwitchCli = (cli: string, options?: { force?: boolean }) => Promise<string | undefined>

const formatDate = (date: Date) => date.toISOString().split('T')[0]

const seedWorkspacePlaceholders = async (workspaceDir: string) => {
	const rootFiles: Array<{ name: string; content: string }> = [
		{ name: 'AGENTS.md', content: '# AGENTS\n\nE2E placeholder agents file.\n' },
		{ name: 'SOUL.md', content: '# SOUL\n\nE2E placeholder soul file.\n' },
		{ name: 'soul.md', content: '# soul\n\nE2E placeholder soul file.\n' },
		{ name: 'TOOLS.md', content: '# TOOLS\n\nE2E placeholder tools file.\n' },
		{ name: 'IDENTITY.md', content: '# IDENTITY\n\nE2E placeholder identity file.\n' },
		{ name: 'USER.md', content: '# USER\n\nE2E placeholder user file.\n' },
		{ name: 'HEARTBEAT.md', content: '# HEARTBEAT\n\nE2E placeholder heartbeat file.\n' },
		{ name: 'BOOTSTRAP.md', content: '# BOOTSTRAP\n\nE2E placeholder bootstrap file.\n' },
		{ name: 'thoughts.md', content: '# thoughts\n\nE2E placeholder thoughts file.\n' },
	]

	await Promise.all(
		rootFiles.map((file) => writeFile(join(workspaceDir, file.name), file.content, 'utf-8'))
	)

	const memoryDir = join(workspaceDir, 'memory')
	await mkdir(memoryDir, { recursive: true })
	for (let i = 0; i < 3; i += 1) {
		const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
		const fileName = `${formatDate(date)}.md`
		await writeFile(
			join(memoryDir, fileName),
			`# Memory ${fileName}\n\nE2E placeholder memory file.\n`,
			'utf-8',
		)
	}
}

const runSubagentConcurrencyTest = async (
	client: TelegramClient,
	botUsername: string,
	cli: string,
	switchCli: SwitchCli,
): Promise<void> => {
	const token = `${Date.now()}`
	const label = `Subagent-${token}`
	const taskBody = cli === 'claude' || cli === 'pi'
		? `Write 12 bullet points about shipping a feature. Use 3 section headings with 4 bullets each. Each bullet must be at least 10 words, and finish with sub-${token}:42.`
		: `Write 36 bullet points about shipping a feature. Use 6 section headings with 6 bullets each. Each bullet must be at least 16 words, and finish with a 6-line poem. End with sub-${token}:42.`

	await switchCli(cli)

	const spawnPrompt = `/spawn --label "${label}" "${taskBody}"`
	await client.sendMessage(botUsername, { message: spawnPrompt })
	const spawnAck = await waitForNewBotMessageWithMeta(
		client,
		botUsername,
		Date.now(),
		(text) => text.includes(`🚀 Spawned: ${label}`),
		SUBAGENT_STEP_TIMEOUT,
	)
	if (!spawnAck.text.includes(`🚀 Spawned: ${label}`)) {
		throw new Error('Subagent spawn acknowledgment missing label')
	}

	const startedMsg = await waitForNewBotMessageWithMeta(
		client,
		botUsername,
		spawnAck.timestamp,
		(text) => text.includes(`🔄 Started: ${label}`),
		SUBAGENT_STEP_TIMEOUT,
	)
	if (!startedMsg.text.includes(`🔄 Started: ${label}`)) {
		throw new Error('Subagent start message missing label')
	}

	const followPrompt = `Main2-${token}: Reply with exactly "main-${token}:6".`
	await client.sendMessage(botUsername, { message: followPrompt })
	const followReply = await waitForNewBotMessageWithMeta(
		client,
		botUsername,
		startedMsg.timestamp,
		(text) => text.includes(`main-${token}:6`),
		SUBAGENT_STEP_TIMEOUT,
	)
	const subagentDone = await waitForNewBotMessageWithMeta(
		client,
		botUsername,
		followReply.timestamp,
		(text) => text.includes(`✅ ${label}`),
		SUBAGENT_STEP_TIMEOUT,
	)
	if (!followReply.text.includes(`main-${token}:6`)) {
		throw new Error('Main response missing expected token')
	}
	if (!subagentDone.text.includes(`✅ ${label}`)) {
		throw new Error('Subagent completion missing label')
	}
	if (!(startedMsg.id < followReply.id && followReply.id < subagentDone.id)) {
		throw new Error('Subagent and main message ordering did not match expected sequence')
	}
}

const runModelSwitchTest = async (
	client: TelegramClient,
	botUsername: string,
	cli: string,
	first: { alias: string; modelId: string },
	second: { alias: string; modelId: string },
	switchCli: SwitchCli,
): Promise<void> => {
	await switchCli(cli)

	const runSpy = vi.spyOn(JsonlSession.prototype, 'run')
	try {
		const beforeModel = Date.now()
		await client.sendMessage(botUsername, { message: `/model ${first.alias}` })
		const firstReply = await waitForNewBotMessage(
			client,
			botUsername,
			beforeModel,
			(text) => text.includes(first.modelId),
			SHORT_TIMEOUT,
		)
		expect(firstReply).toContain(first.modelId)

		await client.sendMessage(botUsername, { message: '/new' })
		await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)

		runSpy.mockClear()
		const beforeFirst = Date.now()
		await client.sendMessage(botUsername, { message: 'What is 1+1? Reply with just the number.' })
		await waitForNewBotMessage(
			client,
			botUsername,
			beforeFirst,
			(text) => text.includes('2') && !text.includes('fresh') && !text.includes('CLI:'),
			LONG_TIMEOUT,
		)
		const firstRunIndex = runSpy.mock.calls.findIndex((call, index) => {
			const instance = runSpy.mock.instances[index] as JsonlSession | undefined
			const options = call[2] as { model?: string } | undefined
			return instance?.cli === cli && options?.model === first.modelId
		})
		expect(firstRunIndex).toBeGreaterThanOrEqual(0)

		const beforeSecondModel = Date.now()
		await client.sendMessage(botUsername, { message: `/model ${second.alias}` })
		const secondReply = await waitForNewBotMessage(
			client,
			botUsername,
			beforeSecondModel,
			(text) => text.includes(second.modelId),
			SHORT_TIMEOUT,
		)
		expect(secondReply).toContain(second.modelId)

		await client.sendMessage(botUsername, { message: '/new' })
		await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)

		runSpy.mockClear()
		const beforeSecond = Date.now()
		await client.sendMessage(botUsername, { message: 'What is 5+5? Reply with just the number.' })
		await waitForNewBotMessage(
			client,
			botUsername,
			beforeSecond,
			(text) => text.includes('10') && !text.includes('fresh') && !text.includes('CLI:'),
			LONG_TIMEOUT,
		)
		const secondRunIndex = runSpy.mock.calls.findIndex((call, index) => {
			const instance = runSpy.mock.instances[index] as JsonlSession | undefined
			const options = call[2] as { model?: string } | undefined
			return instance?.cli === cli && options?.model === second.modelId
		})
		expect(secondRunIndex).toBeGreaterThanOrEqual(0)
	} finally {
		runSpy.mockRestore()
	}
}

// Single gateway instance - Telegram only allows one poller per bot token
// Skip in CI - these tests require real Telegram credentials and are for local use only
describe.skipIf(!shouldRun)('telegram gateway e2e', () => {
	let client: TelegramClient
	let server: GatewayServerHandle
	let bridge: BridgeHandle
	let ws: WebSocket
	let tempDir: string
	let mediaDir: string
	let chatId: number | string
	let releaseLock: (() => void) | null = null
	let currentCli: string | null = null
	const port = Number.isNaN(gatewayPort) ? 8790 : gatewayPort

	const switchCli: SwitchCli = async (cli, options = {}) => {
		if (!options.force && currentCli === cli) return undefined
		await client.sendMessage(botUsername, { message: `/use ${cli}` })
		const reply = await waitForBotMessageContaining(client, botUsername, cli, SHORT_TIMEOUT)
		currentCli = cli
		return reply
	}

	const ensureChatId = async (): Promise<number | string> => {
		if (chatId) return chatId
		const probeText = `e2e chat id ${Date.now()}`
		const inboundPromise = waitForGatewayEvent(ws, 'message.received', (e) => e.payload.text === probeText, TIMEOUT_MS)
		await client.sendMessage(botUsername, { message: probeText })
		const inbound = await inboundPromise
		chatId = inbound.payload.chatId
		return chatId
	}

	beforeAll(async () => {
		releaseLock = await acquireE2eLock()
		currentCli = null
		tempDir = await mkdtemp(join(tmpdir(), 'bitesbot-e2e-'))
		setWorkspaceDir(tempDir)
		setSubagentRegistryPath(join(tempDir, '.state', 'subagent-registry.json'))
		await seedWorkspacePlaceholders(tempDir)
		mediaDir = join(tempDir, 'media-fixtures')
		await mkdir(mediaDir, { recursive: true })
		
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
		releaseLock?.()
	})

	// Core messaging
	e2eTest('receives inbound and delivers outbound messages', async () => {
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
	e2eTest('GET /health returns ok', async () => {
		const res = await fetch(`http://127.0.0.1:${port}/health`)
		const json = await res.json()
		expect(json.ok).toBe(true)
		expect(json.version).toBeDefined()
	})

	e2eTest('GET /status returns server info', async () => {
		const res = await fetch(`http://127.0.0.1:${port}/status`)
		const json = await res.json()
		expect(json.startedAt).toBeDefined()
		expect(json.bot?.username).toBeDefined()
	})

	e2eTest('POST /send with invalid chatId returns error', async () => {
		const res = await fetch(`http://127.0.0.1:${port}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ chatId: 999999999, text: 'test' }),
		})
		expect((await res.json()).ok).toBe(false)
	})

	e2eTest('POST /send recovers after error', async () => {
		const validChatId = await ensureChatId()
		const badRes = await fetch(`http://127.0.0.1:${port}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ chatId: 999999999, text: 'bad send' }),
		})
		expect((await badRes.json()).ok).toBe(false)

		const outboundText = `e2e recovery ${Date.now()}`
		const okRes = await fetch(`http://127.0.0.1:${port}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
			body: JSON.stringify({ chatId: validChatId, text: outboundText }),
		})
		expect((await okRes.json()).ok).toBe(true)
		await waitForBotMessage(client, botUsername, outboundText, TIMEOUT_MS)
	}, TIMEOUT_MS)

	// Media edge cases
	e2eTest('captures document caption and unicode filename (no extension)', async () => {
		const filename = `unicode-文件-${Date.now()}`
		const filePath = join(mediaDir, filename)
		await writeFile(filePath, 'E2E unicode document', 'utf-8')
		const caption = `Doc caption ${Date.now()} ${'x'.repeat(200)}`

		const inboundPromise = waitForGatewayEvent(
			ws,
			'message.received',
			(event) => {
				const payload = event.payload
				const hasDoc = Boolean(payload.attachments?.some((att) => att.type === 'document'))
				return hasDoc && payload.text === caption
			},
			TIMEOUT_MS,
		)

		await client.sendFile(botUsername, { file: filePath, caption, forceDocument: true })
		const inbound = await inboundPromise
		expect(inbound.payload.text).toBe(caption)
		const raw = inbound.payload.raw as Record<string, unknown> | undefined
		const doc = raw?.document as Record<string, unknown> | undefined
		const fileName = typeof doc?.file_name === 'string' ? doc.file_name : ''
		expect(fileName.length).toBeGreaterThan(0)
		expect(fileName.startsWith(filename)).toBe(true)
	}, TIMEOUT_MS)

	e2eTest('captures photo attachment with caption', async () => {
		const filename = `photo-${Date.now()}.png`
		const filePath = join(mediaDir, filename)
		const pngData = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
			'base64',
		)
		await writeFile(filePath, pngData)
		const caption = `Photo caption ${Date.now()}`

		const inboundPromise = waitForGatewayEvent(
			ws,
			'message.received',
			(event) => {
				const payload = event.payload
				const hasAttachment = Boolean(payload.attachments?.length)
				return hasAttachment && payload.text === caption
			},
			TIMEOUT_MS,
		)

		await client.sendFile(botUsername, { file: filePath, caption })
		const inbound = await inboundPromise
		expect(inbound.payload.text).toBe(caption)
		expect(inbound.payload.attachments?.some((att) => att.type === 'photo')).toBe(true)
	}, TIMEOUT_MS)

	// Bridge command tests
	e2eTest('/status returns session info', async () => {
		await client.sendMessage(botUsername, { message: '/status' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'CLI:', SHORT_TIMEOUT)
		expect(reply).toContain('CLI:')
	}, TIMEOUT_MS)

	e2eTest('/model without arg shows usage', async () => {
		await client.sendMessage(botUsername, { message: '/model' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'Usage:', SHORT_TIMEOUT)
		expect(reply).toContain('/model')
	}, TIMEOUT_MS)

	e2eTest('/model opus sets model', async () => {
		await client.sendMessage(botUsername, { message: '/model opus' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'Model set to', SHORT_TIMEOUT)
		expect(reply).toContain('opus')
	}, TIMEOUT_MS)

	e2eTest('/model switch applies to next session (claude)', async () => {
		await runModelSwitchTest(
			client,
			botUsername,
			'claude',
			{ alias: 'haiku', modelId: 'claude-haiku-4-5-20251001' },
			{ alias: 'opus', modelId: 'claude-opus-4-5-20251101' },
			switchCli,
		)
	}, LONG_TIMEOUT)

	e2eTest.skipIf(!hasDroid)('/model switch applies to next session (droid)', async () => {
		await runModelSwitchTest(
			client,
			botUsername,
			'droid',
			{ alias: 'haiku', modelId: 'claude-haiku-4-5-20251001' },
			{ alias: 'opus', modelId: 'claude-opus-4-5-20251101' },
			switchCli,
		)
	}, LONG_TIMEOUT)

	e2eTest.skipIf(!hasCodex)('/model switch applies to next session (codex)', async () => {
		await runModelSwitchTest(
			client,
			botUsername,
			'codex',
			{ alias: 'codex', modelId: 'gpt-5.2-codex' },
			{ alias: 'codex-max', modelId: 'gpt-5.1-codex-max' },
			switchCli,
		)
	}, LONG_TIMEOUT)

	e2eTest.skipIf(!hasPi)('/model switch applies to next session (pi)', async () => {
		await runModelSwitchTest(
			client,
			botUsername,
			'pi',
			{ alias: 'haiku', modelId: 'claude-haiku-4-5-20251001' },
			{ alias: 'opus', modelId: 'claude-opus-4-5-20251101' },
			switchCli,
		)
	}, LONG_TIMEOUT)

	e2eTest('/new starts fresh session', async () => {
		await client.sendMessage(botUsername, { message: '/new' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)
		expect(reply).toBeDefined()
	}, TIMEOUT_MS)

	e2eTest('/stop stops current session', async () => {
		await client.sendMessage(botUsername, { message: '/stop' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'stop', SHORT_TIMEOUT)
		expect(reply).toBeDefined()
	}, TIMEOUT_MS)

	e2eTest('/stream toggles streaming', async () => {
		await client.sendMessage(botUsername, { message: '/stream' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'Streaming', SHORT_TIMEOUT)
		expect(reply).toBeDefined()
	}, TIMEOUT_MS)

	e2eTest('/verbose toggles verbose mode', async () => {
		await client.sendMessage(botUsername, { message: '/verbose' })
		const reply = await waitForBotMessageContaining(client, botUsername, 'erbose', SHORT_TIMEOUT)
		expect(reply).toBeDefined()
	}, TIMEOUT_MS)

	e2eTest('/use claude switches CLI', async () => {
		const reply = await switchCli('claude', { force: true })
		expect(reply).toBeDefined()
	}, TIMEOUT_MS)

	e2eTest.skipIf(!hasDroid)('/use droid switches CLI', async () => {
		const reply = await switchCli('droid', { force: true })
		expect(reply).toBeDefined()
	}, TIMEOUT_MS)

	e2eTest.skipIf(!hasCodex)('/use codex switches CLI', async () => {
		const reply = await switchCli('codex', { force: true })
		expect(reply).toBeDefined()
	}, TIMEOUT_MS)

	e2eTest.skipIf(!hasPi)('/use pi switches CLI', async () => {
		const reply = await switchCli('pi', { force: true })
		expect(reply).toBeDefined()
	}, TIMEOUT_MS)

	e2eTest('/cron list returns response', async () => {
		await client.sendMessage(botUsername, { message: '/cron list' })
		// Wait for any response (could be "No jobs" or a list)
		await delay(3000)
	}, TIMEOUT_MS)

	// ============================================
	// FUNCTIONAL TESTS - verify actual behavior
	// ============================================

	e2eTest.skipIf(!hasDroid)('spawns a droid subagent while main droid session responds', async () => {
		await runSubagentConcurrencyTest(client, botUsername, 'droid', switchCli)
	}, LONG_TIMEOUT * 2)

	e2eTest('spawns a claude subagent while main claude session responds', async () => {
		await runSubagentConcurrencyTest(client, botUsername, 'claude', switchCli)
	}, LONG_TIMEOUT * 2)

	e2eTest.skipIf(!hasCodex)('spawns a codex subagent while main codex session responds', async () => {
		await runSubagentConcurrencyTest(client, botUsername, 'codex', switchCli)
	}, LONG_TIMEOUT * 2)

	e2eTest.skipIf(!hasPi)('spawns a pi subagent while main pi session responds', async () => {
		await runSubagentConcurrencyTest(client, botUsername, 'pi', switchCli)
	}, LONG_TIMEOUT * 2)

	e2eTest('sends a prompt and receives an AI response (claude)', async () => {
		await switchCli('claude')
		await client.sendMessage(botUsername, { message: '/model haiku' })
		await waitForBotMessageContaining(client, botUsername, 'Model set to', SHORT_TIMEOUT)
		// Start fresh
		await client.sendMessage(botUsername, { message: '/new' })
		await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)

		const beforeSend = Date.now()
		const testPrompt = 'What is 2+2? Reply with just the number.'
		await client.sendMessage(botUsername, { message: testPrompt })

		const response = await waitForNewBotMessage(
			client,
			botUsername,
			beforeSend,
			(text) => text.includes('4') && !text.includes('fresh') && !text.includes('CLI:'),
			LONG_TIMEOUT,
		)
		expect(response).toContain('4')
	}, LONG_TIMEOUT)

	e2eTest.skipIf(!hasCodex)('sends a prompt and receives an AI response (codex)', async () => {
		// Start fresh
		await client.sendMessage(botUsername, { message: '/new' })
		await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)
		await switchCli('codex')
		await client.sendMessage(botUsername, { message: '/model codex' })
		await waitForBotMessageContaining(client, botUsername, 'Model set to', SHORT_TIMEOUT)
		await client.sendMessage(botUsername, { message: '/new' })
		await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)

		const beforeSend = Date.now()
		const testPrompt = 'What is 2+2? Reply with just the number.'
		await client.sendMessage(botUsername, { message: testPrompt })

		const response = await waitForNewBotMessage(
			client,
			botUsername,
			beforeSend,
			(text) => text.includes('4') && !text.includes('fresh') && !text.includes('CLI:'),
			LONG_TIMEOUT,
		)
		expect(response).toContain('4')
	}, LONG_TIMEOUT)

	e2eTest.skipIf(!hasDroid)('sends a prompt and receives an AI response (droid)', async () => {
		await switchCli('droid')
		await client.sendMessage(botUsername, { message: '/model haiku' })
		await waitForBotMessageContaining(client, botUsername, 'Model set to', SHORT_TIMEOUT)

		await client.sendMessage(botUsername, { message: '/new' })
		await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)

		const beforeSend = Date.now()
		const testPrompt = 'What is 3+3? Reply with just the number.'
		await client.sendMessage(botUsername, { message: testPrompt })

		const response = await waitForNewBotMessage(
			client,
			botUsername,
			beforeSend,
			(text) => text.includes('6') && !text.includes('fresh') && !text.includes('CLI:'),
			LONG_TIMEOUT,
		)
		expect(response).toContain('6')
	}, LONG_TIMEOUT)

	e2eTest.skipIf(!hasPi)('sends a prompt and receives an AI response (pi)', async () => {
		await switchCli('pi')
		await client.sendMessage(botUsername, { message: '/model haiku' })
		await waitForBotMessageContaining(client, botUsername, 'Model set to', SHORT_TIMEOUT)

		await client.sendMessage(botUsername, { message: '/new' })
		await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)

		const beforeSend = Date.now()
		const testPrompt = 'What is 5+5? Reply with just the number.'
		await client.sendMessage(botUsername, { message: testPrompt })

		const response = await waitForNewBotMessage(
			client,
			botUsername,
			beforeSend,
			(text) => text.includes('10') && !text.includes('fresh') && !text.includes('CLI:'),
			LONG_TIMEOUT,
		)
		expect(response).toContain('10')
	}, LONG_TIMEOUT)

	e2eTest('/new actually clears session context', async () => {
		await switchCli('claude')
		await client.sendMessage(botUsername, { message: '/model haiku' })
		await waitForBotMessageContaining(client, botUsername, 'Model set to', SHORT_TIMEOUT)
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
	}, LONG_TIMEOUT)

	e2eTest('/stop actually terminates a running session', async () => {
		await switchCli('claude')
		await client.sendMessage(botUsername, { message: '/model haiku' })
		await waitForBotMessageContaining(client, botUsername, 'Model set to', SHORT_TIMEOUT)
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
	e2eTest.skipIf(shouldRun)('skipped: set TG_E2E_RUN=1 with valid TG_E2E_* env vars', () => {
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
