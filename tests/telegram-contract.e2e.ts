import { afterAll, beforeAll, beforeEach, describe, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { startBridge, setWorkspaceDir } from '../src/bridge/index.js'
import { toTelegramMarkdown } from '../src/gateway/telegram-markdown.js'
import { e2eTest } from './e2e-checkpoint.js'

type ApiCall = {
	method: string
	chatId: number | string
	text?: string
	caption?: string
}

class FakeApi {
	calls: ApiCall[] = []
	chatActions: Array<{ chatId: number | string; action: string }> = []
	private messageId = 0

	async getMe() {
		return { id: 999, username: 'mock-bot', first_name: 'Mock' }
	}

	async setMyCommands() {
		return true
	}

	async sendMessage(chatId: number | string, text: string) {
		this.messageId += 1
		this.calls.push({ method: 'sendMessage', chatId, text })
		return { message_id: this.messageId }
	}

	async sendPhoto(chatId: number | string, photo: string, options?: { caption?: string }) {
		this.messageId += 1
		this.calls.push({ method: 'sendPhoto', chatId, text: photo, caption: options?.caption })
		return { message_id: this.messageId }
	}

	async sendDocument(chatId: number | string, document: unknown, options?: { caption?: string }) {
		this.messageId += 1
		this.calls.push({ method: 'sendDocument', chatId, text: String(document), caption: options?.caption })
		return { message_id: this.messageId }
	}

	async sendChatAction(chatId: number | string, action: string) {
		this.chatActions.push({ chatId, action })
		return true
	}

	async getFile(fileId: string) {
		return { file_path: `mock/${fileId}` }
	}

	async answerCallbackQuery() {
		return true
	}
}

const createdBots: FakeBot[] = []

class FakeBot extends EventEmitter {
	readonly api = new FakeApi()
	readonly token: string
	private errorHandler?: (error: Error) => void

	constructor(token: string) {
		super()
		this.token = token
		createdBots.push(this)
	}

	catch(handler: (error: Error) => void) {
		this.errorHandler = handler
		return this
	}

	async start() {
		return true
	}

	async stop() {
		return true
	}

	emitError(error: Error) {
		this.errorHandler?.(error)
	}
}

class FakeInputFile {
	constructor(readonly stream: unknown, readonly filename?: string) {}
}

vi.mock('grammy', () => ({
	Bot: FakeBot,
	InputFile: FakeInputFile,
}))

type GatewayServerHandle = Awaited<ReturnType<typeof import('../src/gateway/server.js').startGatewayServer>>

const getFreePort = async (): Promise<number> => {
	const server = createServer()
	return await new Promise((resolve, reject) => {
		server.on('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('failed to resolve port')))
				return
			}
			server.close(() => resolve(address.port))
		})
	})
}

const waitFor = async (predicate: () => boolean, timeoutMs = 15_000) => {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return
		await delay(20)
	}
	throw new Error('timeout')
}

const unescapeTelegram = (value: string) =>
	value.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1')

const waitForOutboundText = async (api: FakeApi, text: string, timeoutMs = 15_000) => {
	const escaped = toTelegramMarkdown(text)
	await waitFor(() => {
		return api.calls.some((call) => {
			const raw = call.text ?? call.caption ?? ''
			const normalized = unescapeTelegram(raw)
			return raw.includes(text) || raw.includes(escaped) || normalized.includes(text)
		})
	}, timeoutMs)
}

const sendTelegramMessage = (bot: FakeBot, chatId: number, text: string) => {
	const message = {
		message_id: Math.floor(Math.random() * 100000),
		date: Math.floor(Date.now() / 1000),
		chat: { id: chatId, type: 'private' },
		from: { id: chatId, is_bot: false, first_name: 'Tester' },
		text,
	}
	bot.emit('message', { message })
}

describe('telegram contract gate', () => {
	let startGatewayServer: typeof import('../src/gateway/server.js').startGatewayServer
	let server: GatewayServerHandle
	let bridge: Awaited<ReturnType<typeof startBridge>>
	let bot: FakeBot
	let api: FakeApi
	let workspaceDir: string
	let adaptersDir: string
	let port: number
	const chatId = 123456

	beforeAll(async () => {
		const module = await import('../src/gateway/server.js')
		startGatewayServer = module.startGatewayServer

		workspaceDir = await mkdtemp(join(tmpdir(), 'bitesbot-telegram-gate-'))
		adaptersDir = await mkdtemp(join(tmpdir(), 'bitesbot-adapters-'))
		setWorkspaceDir(workspaceDir)

		const mockCliPath = join(process.cwd(), 'tests', 'fixtures', 'mock-cli.mjs')
		const manifestPath = join(adaptersDir, 'pi.yaml')
		const manifest = [
			'name: pi',
			`command: "${process.execPath}"`,
			'args:',
			`  - "${mockCliPath}"`,
			'inputMode: jsonl',
		].join('\n')
		await writeFile(manifestPath, `${manifest}\n`, 'utf-8')

		port = await getFreePort()
		server = await startGatewayServer({
			botToken: 'test-token',
			host: '127.0.0.1',
			port,
			bridge: {
				enabled: true,
				defaultCli: 'pi',
				workingDirectory: workspaceDir,
				adaptersDir,
			},
		})
		bridge = await startBridge({
			gatewayUrl: `http://127.0.0.1:${port}`,
			adaptersDir,
			defaultCli: 'pi',
			workingDirectory: workspaceDir,
		})
		bot = createdBots[createdBots.length - 1] as FakeBot
		api = bot.api
		await delay(100)
	}, 30_000)

	beforeEach(() => {
		if (api) {
			api.calls = []
			api.chatActions = []
		}
	})

	afterAll(async () => {
		bridge?.close()
		if (server) await server.close()
		if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true })
		if (adaptersDir) await rm(adaptersDir, { recursive: true, force: true })
	})

	e2eTest('handles slash commands', async () => {
		sendTelegramMessage(bot, chatId, '/status')
		await waitForOutboundText(api, 'CLI: pi')

		sendTelegramMessage(bot, chatId, '/model haiku')
		await waitForOutboundText(api, 'Model set to:')

		sendTelegramMessage(bot, chatId, '/new')
		await waitForOutboundText(api, 'Starting fresh')

		sendTelegramMessage(bot, chatId, '/stop')
		await waitForOutboundText(api, 'No active session')

		sendTelegramMessage(bot, chatId, '/use missing-cli')
		await waitForOutboundText(api, 'Unknown CLI')
	})

	e2eTest('reads and writes files through tool flow', async () => {
		const filePath = join(workspaceDir, 'test-output', `file-${Date.now()}.txt`)
		const content = `hello-${Date.now()}`
		const writePayload = { action: 'write', path: filePath, content }
		sendTelegramMessage(bot, chatId, `E2E_PAYLOAD:${JSON.stringify(writePayload)}`)
		await waitForOutboundText(api, 'Wrote')
		expect(existsSync(filePath)).toBe(true)
		const written = await readFile(filePath, 'utf-8')
		expect(written).toBe(content)

		const readPayload = { action: 'read', path: filePath }
		sendTelegramMessage(bot, chatId, `E2E_PAYLOAD:${JSON.stringify(readPayload)}`)
		await waitForOutboundText(api, content)
	})

	e2eTest('batches queued messages while main session is busy', async () => {
		const firstPayload = { action: 'echo', text: 'first-response', sleepMs: 1200 }
		const secondPayload = { action: 'echo', text: 'second-response' }
		sendTelegramMessage(bot, chatId, `E2E_PAYLOAD:${JSON.stringify(firstPayload)}`)
		await waitFor(() => api.chatActions.some((entry) => entry.chatId === chatId))
		await delay(50)
		sendTelegramMessage(bot, chatId, `E2E_PAYLOAD:${JSON.stringify(secondPayload)}`)

		await waitForOutboundText(api, 'Queued')
		await waitForOutboundText(api, 'first-response')
		await waitForOutboundText(api, 'second-response')
	})

	e2eTest('spawns subagents and reports completion', async () => {
		sendTelegramMessage(bot, chatId, '/spawn "task one"')
		sendTelegramMessage(bot, chatId, '/spawn "task two"')

		await waitForOutboundText(api, '🚀 Spawned', 8000)
		await waitForOutboundText(api, '🔄 Started', 8000)
		await waitForOutboundText(api, '✅', 8000)
	})

	e2eTest('sends typing indicators during work', async () => {
		const payload = { action: 'echo', text: 'typing-check', sleepMs: 300 }
		sendTelegramMessage(bot, chatId, `E2E_PAYLOAD:${JSON.stringify(payload)}`)
		await waitForOutboundText(api, 'typing-check')
		await waitFor(() => api.chatActions.some((entry) => entry.chatId === chatId), 5000)
	})
})
