import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Bot } from 'grammy'
import { WebSocketServer } from 'ws'
import { isAuthorized } from './auth.js'
import type { GatewayConfig } from './config.js'
import { normalizeMessage } from './normalize.js'
import type {
	GatewayEvent,
	HealthResponse,
	OutboundMessage,
	SendResponse,
	StatusResponse,
} from '../protocol/types.js'
import { PROTOCOL_VERSION } from '../protocol/types.js'

export type GatewayServerHandle = {
	close: () => Promise<void>
	startedAt: Date
	getConnections: () => number
}

const readBody = async (req: IncomingMessage) => {
	const chunks: Buffer[] = []
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf-8')
}

const sendJson = (res: ServerResponse, status: number, payload: unknown) => {
	res.writeHead(status, { 'content-type': 'application/json' })
	res.end(JSON.stringify(payload))
}

const resolvePath = (req: IncomingMessage) => {
	const url = new URL(req.url ?? '/', 'http://localhost')
	return url.pathname
}

// Convert common markdown to Telegram MarkdownV2
const toTelegramMarkdown = (text: string): string => {
	let result = text

	// Escape special chars that aren't part of formatting
	result = result.replace(/([.!=|{}])/g, '\\$1')

	// Convert **bold** to *bold* (Telegram style)
	result = result.replace(/\*\*(.+?)\*\*/g, '*$1*')

	// Convert - lists to • (Telegram doesn't support - as list marker)
	result = result.replace(/^- /gm, '• ')

	return result
}

const sendOutboundMessage = async (bot: Bot, payload: OutboundMessage) => {
	const chatId = payload.chatId
	if (payload.photoUrl) {
		const caption = payload.caption ?? payload.text
		return bot.api.sendPhoto(chatId, payload.photoUrl, {
			caption: caption ? toTelegramMarkdown(caption) : undefined,
			reply_to_message_id: payload.replyToMessageId,
			parse_mode: 'MarkdownV2',
		})
	}

	if (payload.documentUrl) {
		const caption = payload.caption ?? payload.text
		return bot.api.sendDocument(chatId, payload.documentUrl, {
			caption: caption ? toTelegramMarkdown(caption) : undefined,
			reply_to_message_id: payload.replyToMessageId,
			parse_mode: 'MarkdownV2',
		})
	}

	if (!payload.text) {
		throw new Error('text is required when no attachment is provided')
	}

	return bot.api.sendMessage(chatId, toTelegramMarkdown(payload.text), {
		reply_to_message_id: payload.replyToMessageId,
		parse_mode: 'MarkdownV2',
	})
}

export const startGatewayServer = async (config: GatewayConfig): Promise<GatewayServerHandle> => {
	const bot = new Bot(config.botToken)
	const startedAt = new Date()
	let botInfo: Awaited<ReturnType<typeof bot.api.getMe>> | undefined

	try {
		botInfo = await bot.api.getMe()
	} catch {
		botInfo = undefined
	}

	const server = createServer(async (req, res) => {
		if (!isAuthorized(req, config)) {
			sendJson(res, 401, { ok: false, error: 'unauthorized' })
			return
		}

		const path = resolvePath(req)
		if (req.method === 'GET' && path === '/health') {
			const payload: HealthResponse = { ok: true, version: PROTOCOL_VERSION }
			sendJson(res, 200, payload)
			return
		}

		if (req.method === 'GET' && path === '/status') {
			const payload: StatusResponse = {
				startedAt: startedAt.toISOString(),
				uptimeMs: Date.now() - startedAt.getTime(),
				connections: wss.clients.size,
				bot: botInfo
					? {
						id: botInfo.id,
						username: botInfo.username,
						firstName: botInfo.first_name,
					}
					: undefined,
			}
			sendJson(res, 200, payload)
			return
		}

		if (req.method === 'POST' && path === '/send') {
			try {
				const raw = await readBody(req)
				const payload = JSON.parse(raw) as OutboundMessage
				const response = await sendOutboundMessage(bot, payload)
				const sendResponse: SendResponse = {
					ok: true,
					messageId: response.message_id,
				}
				broadcast({
					type: 'message.sent',
					payload: { chatId: payload.chatId, messageId: response.message_id },
				})
				sendJson(res, 200, sendResponse)
			} catch (error) {
				const message = error instanceof Error ? error.message : 'unknown error'
				broadcast({ type: 'error', payload: { message } })
				sendJson(res, 400, { ok: false, error: message })
			}
			return
		}

		sendJson(res, 404, { ok: false, error: 'not found' })
	})

	const wss = new WebSocketServer({ noServer: true })

	const broadcast = (event: GatewayEvent) => {
		const data = JSON.stringify(event)
		wss.clients.forEach((client) => {
			if (client.readyState === client.OPEN) {
				client.send(data)
			}
		})
	}

	server.on('upgrade', (req, socket, head) => {
		const path = resolvePath(req)
		if (path !== '/events' || !isAuthorized(req, config)) {
			socket.destroy()
			return
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit('connection', ws, req)
		})
	})

	bot.on('message', (ctx) => {
		const normalized = normalizeMessage(ctx.message)
		broadcast({ type: 'message.received', payload: normalized })
	})

	bot.catch((error) => {
		broadcast({ type: 'error', payload: { message: error.message } })
	})

	await new Promise<void>((resolve) => {
		server.listen(config.port, config.host, () => resolve())
	})

	void bot.start()

	return {
		startedAt,
		getConnections: () => wss.clients.size,
		close: async () => {
			wss.close()
			await bot.stop()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		},
	}
}
