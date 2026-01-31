/**
 * Isolated PI Agent E2E
 *
 * Run: TG_E2E_RUN=1 TG_E2E_AGENT=pi pnpm test:e2e --grep "pi agent"
 *
 * Required env vars:
 * - TG_E2E_API_ID, TG_E2E_API_HASH, TG_E2E_SESSION
 * - TG_E2E_BOT_TOKEN, TG_E2E_BOT_USERNAME
 * - TG_E2E_ALLOWED_CHAT_ID
 */
import { describe, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { TelegramClient, sessions } from 'telegram'
import WebSocket from 'ws'
import { setTimeout as delay } from 'node:timers/promises'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { startGatewayServer, type GatewayServerHandle } from '../src/gateway/server.js'
import { startBridge, type BridgeHandle, setWorkspaceDir } from '../src/bridge/index.js'
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
const agentFilter = (process.env.TG_E2E_AGENT ?? '')
	.split(',')
	.map((value) => value.trim().toLowerCase())
	.filter(Boolean)

const botUsername = botUsernameRaw
	? botUsernameRaw.startsWith('@') ? botUsernameRaw : `@${botUsernameRaw}`
	: ''
const basePort = Number(gatewayPortRaw ?? '8790')
const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS)
const hasEnv = Boolean(apiId && apiHash && sessionStr && botToken && botUsername && allowedChatIdEnv)
const shouldRun = hasEnv && !isCI && process.env.TG_E2E_RUN === '1' && agentFilter.includes('pi')

const SHORT_TIMEOUT = 30_000
const LONG_TIMEOUT = 180_000
const POLL_DELAY_MS = 2000

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
if (piPath) {
	const piDir = dirname(piPath)
	if (!process.env.PATH?.includes(piDir)) {
		process.env.PATH = `${piDir}:${process.env.PATH ?? ''}`
	}
}

const isNoiseMessage = (text: string) => {
	const trimmed = text.trim()
	return trimmed.startsWith('💰') || trimmed.toLowerCase().startsWith('cost:') || trimmed.toLowerCase().startsWith('switched to ')
}

const formatEventLog = (events: Array<{ ts: string; event: GatewayEvent }>) => {
	return events
		.slice(-20)
		.map(({ ts, event }) => {
			const preview = JSON.stringify(event.payload ?? {}, null, 0).slice(0, 200)
			return `[${ts}] ${event.type} ${preview}`
		})
		.join('\n')
}

const waitForBotMessageContaining = async (
	client: TelegramClient,
	bot: string,
	substring: string,
	timeoutMs: number,
	events: Array<{ ts: string; event: GatewayEvent }>,
) => {
	const deadline = Date.now() + timeoutMs
	const cutoff = Date.now() - 1500
	const needle = substring.toLowerCase()
	const seenIds = new Set<number>()
	while (Date.now() < deadline) {
		const messages = await client.getMessages(bot, { limit: 12 })
		for (const msg of messages) {
			if (!('message' in msg) || !msg.message || msg.out === true || !msg.id) continue
			if (seenIds.has(msg.id)) continue
			const msgDate = msg.date ? msg.date * 1000 : 0
			if (msgDate < cutoff) continue
			const text = String(msg.message)
			if (isNoiseMessage(text)) continue
			seenIds.add(msg.id)
			if (text.toLowerCase().includes(needle)) return text
		}
		await delay(POLL_DELAY_MS)
	}
	throw new Error(`Timeout waiting for bot reply containing: ${substring}\nRecent gateway events:\n${formatEventLog(events)}`)
}

const waitForActiveCli = async (
	bridge: BridgeHandle,
	chatId: number,
	cli: string,
	timeoutMs: number,
	events: Array<{ ts: string; event: GatewayEvent }>,
) => {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const activeCli = bridge.getSessionStore().getActiveCli(chatId)
		if (activeCli === cli) return
		await delay(POLL_DELAY_MS)
	}
	throw new Error(`Timeout waiting for active CLI: ${cli}\nRecent gateway events:\n${formatEventLog(events)}`)
}

const waitForNewBotMessage = async (
	client: TelegramClient,
	bot: string,
	afterTimestamp: number,
	predicate: (text: string) => boolean,
	timeoutMs: number,
	events: Array<{ ts: string; event: GatewayEvent }>,
): Promise<string> => {
	const deadline = Date.now() + timeoutMs
	const cutoff = Math.max(0, afterTimestamp - 500)
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
			const text = String(msg.message)
			if (isNoiseMessage(text)) continue
			if (predicate(text)) return text
		}
		await delay(POLL_DELAY_MS)
	}
	throw new Error(`Timeout waiting for new bot message\nRecent gateway events:\n${formatEventLog(events)}`)
}

const waitForFile = async (
	filePath: string,
	timeoutMs: number,
	events: Array<{ ts: string; event: GatewayEvent }>,
) => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (existsSync(filePath)) return
		await delay(POLL_DELAY_MS)
	}
	throw new Error(`Timeout waiting for file to be created: ${filePath}\nRecent gateway events:\n${formatEventLog(events)}`)
}

describe.skipIf(!shouldRun)('pi agent isolated e2e', () => {
	let client: TelegramClient
	let server: GatewayServerHandle
	let bridge: BridgeHandle
	let ws: WebSocket
	let tempDir: string
	let workspaceDir: string
	let toolTestDir: string
	let allowedChatId: number
	let releaseLock: (() => void) | null = null
	const eventLog: Array<{ ts: string; event: GatewayEvent }> = []
	const port = Number.isNaN(basePort) ? 8793 : basePort + 3

	beforeAll(async () => {
		releaseLock = await acquireE2eLock()
		allowedChatId = Number(allowedChatIdEnv)
		if (Number.isNaN(allowedChatId)) {
			throw new Error('TG_E2E_ALLOWED_CHAT_ID must be a valid number')
		}

		tempDir = await mkdtemp(join(tmpdir(), 'bitesbot-pi-e2e-'))
		workspaceDir = join(tempDir, 'workspace')
		toolTestDir = join(workspaceDir, 'tool-tests')
		await mkdir(toolTestDir, { recursive: true })
		await mkdir(join(workspaceDir, 'sessions'), { recursive: true })
		await mkdir(join(workspaceDir, '.state'), { recursive: true })
		setWorkspaceDir(workspaceDir)

		server = await startGatewayServer({
			botToken,
			host: '127.0.0.1',
			port,
			allowedChatIds: [allowedChatId],
			authToken: authToken || undefined,
			bridge: {
				enabled: true,
				defaultCli: 'pi',
				workingDirectory: workspaceDir,
				adaptersDir: join(process.cwd(), 'adapters'),
			},
		})

		bridge = await startBridge({
			gatewayUrl: `http://127.0.0.1:${port}`,
			authToken: authToken || undefined,
			adaptersDir: join(process.cwd(), 'adapters'),
			defaultCli: 'pi',
			workingDirectory: workspaceDir,
		})

		ws = new WebSocket(`ws://127.0.0.1:${port}/events`, authToken
			? { headers: { Authorization: `Bearer ${authToken}` } }
			: undefined)

		ws.on('message', (data) => {
			try {
				const event = JSON.parse(data.toString()) as GatewayEvent
				eventLog.push({ ts: new Date().toISOString(), event })
				if (eventLog.length > 200) eventLog.shift()
			} catch {
				// ignore
			}
		})

		await new Promise<void>((resolve, reject) => {
			ws.on('open', () => resolve())
			ws.on('error', reject)
		})

		const { StringSession } = sessions
		client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, { connectionRetries: 5 })
		await client.connect()
		if (!await client.isUserAuthorized()) {
			throw new Error('Telegram client not authorized')
		}
	}, LONG_TIMEOUT)

	beforeEach(async () => {
		if (eventLog.length) eventLog.length = 0
		await client.sendMessage(botUsername, { message: '/use pi' })
		await waitForActiveCli(bridge, allowedChatId, 'pi', SHORT_TIMEOUT, eventLog)
		await client.sendMessage(botUsername, { message: '/status' })
		await waitForBotMessageContaining(client, botUsername, 'CLI: pi', SHORT_TIMEOUT, eventLog)
		await client.sendMessage(botUsername, { message: '/new' })
		await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT, eventLog)
	}, LONG_TIMEOUT)

	afterAll(async () => {
		if (ws && ws.readyState !== WebSocket.CLOSED) {
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

	e2eTest('pi binary is available', async () => {
		expect(piPath, 'pi binary not found in PATH').toBeTruthy()
	})

	e2eTest('responds to a simple prompt', async () => {
		const beforeSend = Date.now()
		await client.sendMessage(botUsername, { message: 'Reply with just "OK".' })
		const reply = await waitForNewBotMessage(
			client,
			botUsername,
			beforeSend,
			(text) => text.toLowerCase().includes('ok'),
			LONG_TIMEOUT,
			eventLog,
		)
		expect(reply.toLowerCase()).toContain('ok')
	})

	e2eTest('can write a file via tool use', async () => {
		const filePath = join(toolTestDir, `pi-write-${Date.now()}.txt`)
		const content = `pi-tool-${Date.now()}`
		await client.sendMessage(botUsername, {
			message: `Create a file at ${filePath} with content "${content}". Reply once done.`,
		})
		await waitForFile(filePath, LONG_TIMEOUT * 2, eventLog)
		const written = await readFile(filePath, 'utf-8')
		expect(written).toContain(content)
	}, LONG_TIMEOUT * 2)
})

describe('pi agent isolated e2e (skipped)', () => {
	e2eTest.skipIf(shouldRun)('skipped: set TG_E2E_RUN=1 and TG_E2E_AGENT=pi with valid TG_E2E_* env vars', () => {
		if (isCI) {
			console.log('Skipped: PI isolated E2E tests are local-only (CI detected)')
		} else if (process.env.TG_E2E_RUN !== '1') {
			console.log('Skipped: TG_E2E_RUN=1 not set')
		} else if (!agentFilter.includes('pi')) {
			console.log('Skipped: TG_E2E_AGENT=pi not set')
		} else {
			console.log('Skipped: Missing TG_E2E_* environment variables')
		}
	})
})
