import { createServer } from 'node:http'
import type { IncomingMessage as HttpIncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename, extname, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { Bot, InputFile } from 'grammy'
import { WebSocketServer, WebSocket } from 'ws'
import { isAuthorized } from './auth.js'
import type { GatewayConfig } from './config.js'
import { normalizeMessage } from './normalize.js'
import { toTelegramMarkdown } from './telegram-markdown.js'
import { logToFile } from '../logging/file.js'
import { isVoiceAttachment, processVoiceAttachment } from './media.js'
import type {
	GatewayEvent,
	HealthResponse,
	OutboundMessage,
	SendResponse,
	StatusResponse,
	TypingRequest,
	IncomingMessage,
} from '../protocol/types.js'
import { PROTOCOL_VERSION } from '../protocol/types.js'
import type { McpServerHandle } from '../mcp/server.js'

// Web client types
type WebClient = {
	ws: WebSocket
	sessionId: string
	chatId: string
}

type WebEvent =
	| { type: 'web.message'; payload: { text: string; inlineButtons?: { text: string; callbackData: string }[][] } }
	| { type: 'web.stream.start'; payload: Record<string, never> }
	| { type: 'web.stream.chunk'; payload: { text: string } }
	| { type: 'web.stream.end'; payload: { text?: string; inlineButtons?: { text: string; callbackData: string }[][] } }
	| { type: 'web.typing'; payload: Record<string, never> }
	| { type: 'web.typing.stop'; payload: Record<string, never> }
	| { type: 'callback.response'; payload: { text: string } }
	| { type: 'error'; payload: { message: string } }

// MIME type map for static files
const MIME_TYPES: Record<string, string> = {
	'.html': 'text/html',
	'.css': 'text/css',
	'.js': 'application/javascript',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
}

export type GatewayServerHandle = {
	close: () => Promise<void>
	startedAt: Date
	getConnections: () => number
	notifyRestart: () => Promise<void>
	addMcpServer: (mcp: McpServerHandle) => void
	sendToWebClient: (chatId: string, event: { type: string; payload: unknown }) => void
	isWebClient: (chatId: string | number) => boolean
}

export type GatewayServerOptions = {
	mcpServer?: McpServerHandle
}

const readBody = async (req: HttpIncomingMessage) => {
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

const resolvePath = (req: HttpIncomingMessage) => {
	const url = new URL(req.url ?? '/', 'http://localhost')
	return url.pathname
}

// Download a Telegram file to local temp directory
const downloadTelegramFile = async (bot: Bot, fileId: string, type: 'photo' | 'document' | 'voice' | 'audio'): Promise<string> => {
	const file = await bot.api.getFile(fileId)
	if (!file.file_path) {
		throw new Error('No file_path returned from Telegram')
	}
	
	const extMap: Record<string, string> = { photo: 'jpg', voice: 'ogg', audio: 'mp3' }
	const ext = extMap[type] ?? (file.file_path.split('.').pop() || 'bin')
	const localDir = join(tmpdir(), 'agent-gateway-files')
	await mkdir(localDir, { recursive: true })
	const localPath = join(localDir, `${fileId}.${ext}`)
	
	const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`
	const response = await fetch(fileUrl)
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download file: ${response.status}`)
	}
	
	const writeStream = createWriteStream(localPath)
	// Readable stream compatibility
	await pipeline(response.body as unknown as NodeJS.ReadableStream, writeStream)
	
	return localPath
}

const sendOutboundMessage = async (bot: Bot, payload: OutboundMessage) => {
	const chatId = payload.chatId

	// Build inline keyboard if provided
	const reply_markup = payload.inlineButtons
		? {
			inline_keyboard: payload.inlineButtons.map((row) =>
				row.map((btn) => ({
					text: btn.text,
					callback_data: btn.callbackData,
				}))
			),
		}
		: undefined

	if (payload.photoUrl) {
		const caption = payload.caption ?? payload.text
		return bot.api.sendPhoto(chatId, payload.photoUrl, {
			caption: caption ? toTelegramMarkdown(caption) : undefined,
			reply_to_message_id: payload.replyToMessageId,
			parse_mode: 'MarkdownV2',
			reply_markup,
		})
	}

	if (payload.documentUrl) {
		const caption = payload.caption ?? payload.text
		return bot.api.sendDocument(chatId, payload.documentUrl, {
			caption: caption ? toTelegramMarkdown(caption) : undefined,
			reply_to_message_id: payload.replyToMessageId,
			parse_mode: 'MarkdownV2',
			reply_markup,
		})
	}

	// Send local file as document
	if (payload.documentPath) {
		// Verify file exists
		await stat(payload.documentPath)
		const filename = payload.documentFilename ?? basename(payload.documentPath)
		const inputFile = new InputFile(createReadStream(payload.documentPath), filename)
		const caption = payload.caption ?? payload.text
		return bot.api.sendDocument(chatId, inputFile, {
			caption: caption ? toTelegramMarkdown(caption) : undefined,
			reply_to_message_id: payload.replyToMessageId,
			parse_mode: 'MarkdownV2',
			reply_markup,
		})
	}

	if (!payload.text) {
		throw new Error('text is required when no attachment is provided')
	}

	return bot.api.sendMessage(chatId, toTelegramMarkdown(payload.text), {
		reply_to_message_id: payload.replyToMessageId,
		parse_mode: 'MarkdownV2',
		reply_markup,
	})
}

export const startGatewayServer = async (config: GatewayConfig, options: GatewayServerOptions = {}): Promise<GatewayServerHandle> => {
	let mcpServer = options.mcpServer
	const bot = new Bot(config.botToken)
	const startedAt = new Date()
	let botInfo: Awaited<ReturnType<typeof bot.api.getMe>> | undefined
	const activeChats = new Set<number>()
	let lastActiveChatId: number | undefined

	// Web client tracking
	const webClients = new Map<string, WebClient>()

	// Get the web directory path (relative to the dist directory)
	const __dirname = fileURLToPath(new URL('.', import.meta.url))
	const webDir = join(__dirname, '..', 'web')

	try {
		botInfo = await bot.api.getMe()
		// Register slash commands menu
		await bot.api.setMyCommands([
			{ command: 'new', description: 'Start fresh session' },
			{ command: 'stop', description: 'Stop current session' },
			{ command: 'interrupt', description: 'Skip current task, keep queue' },
			{ command: 'restart', description: 'Restart the gateway' },
			{ command: 'status', description: 'Show session status' },
			{ command: 'model', description: 'Switch AI model (opus/sonnet/haiku)' },
			{ command: 'use', description: 'Switch CLI (claude/droid)' },
			{ command: 'stream', description: 'Toggle streaming output' },
			{ command: 'verbose', description: 'Toggle tool output' },
			{ command: 'spec', description: 'Create plan for approval' },
			{ command: 'cron', description: 'Manage scheduled jobs' },
		])
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
			let payload: OutboundMessage | undefined
			try {
				const raw = await readBody(req)
				payload = JSON.parse(raw) as OutboundMessage

				// Handle web clients differently
				const chatIdStr = String(payload.chatId)
				if (chatIdStr.startsWith('web:')) {
					// Send to web client
					const webEvent: WebEvent = {
						type: 'web.message',
						payload: {
							text: payload.text || '',
							inlineButtons: payload.inlineButtons?.map(row =>
								row.map(btn => ({ text: btn.text, callbackData: btn.callbackData }))
							),
						},
					}
					sendToWebClient(chatIdStr, webEvent)
					const sendResponse: SendResponse = { ok: true, messageId: Date.now() }
					broadcast({
						type: 'message.sent',
						payload: { chatId: payload.chatId, messageId: Date.now() },
					})
					sendJson(res, 200, sendResponse)
					return
				}

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
				const preview = typeof error === 'object' ? JSON.stringify(error, null, 2).slice(0, 1000) : undefined
				void logToFile('error', 'send failed', {
					error: message,
					chatId: payload?.chatId,
					textLength: payload?.text?.length,
					textPreview: payload?.text?.slice(0, 200),
					photoUrl: payload?.photoUrl,
					documentUrl: payload?.documentUrl,
					errorDetails: preview,
				})
				broadcast({ type: 'error', payload: { message } })
				sendJson(res, 400, { ok: false, error: message })
			}
			return
		}

		if (req.method === 'POST' && path === '/typing') {
			try {
				const raw = await readBody(req)
				const payload = JSON.parse(raw) as TypingRequest
				const chatIdStr = String(payload.chatId)

				// Handle web clients
				if (chatIdStr.startsWith('web:')) {
					sendToWebClient(chatIdStr, { type: 'web.typing', payload: {} })
					sendJson(res, 200, { ok: true })
					return
				}

				const chatId = typeof payload.chatId === 'string' ? Number.parseInt(payload.chatId, 10) : payload.chatId
				await bot.api.sendChatAction(chatId, 'typing')
				sendJson(res, 200, { ok: true })
			} catch (error) {
				const message = error instanceof Error ? error.message : 'unknown error'
				sendJson(res, 400, { ok: false, error: message })
			}
			return
		}

		// MCP SSE endpoint
		if (mcpServer && req.method === 'GET' && path === '/mcp/sse') {
			console.log('[mcp] SSE connection request')
			await mcpServer.handleSse(req, res)
			return
		}

		// MCP messages endpoint
		if (mcpServer && req.method === 'POST' && path === '/mcp/messages') {
			await mcpServer.handleMessages(req, res)
			return
		}

		// Web UI - serve static files
		if (req.method === 'GET' && (path === '/' || path === '/web' || path.startsWith('/web/'))) {
			let filePath: string
			if (path === '/' || path === '/web' || path === '/web/') {
				filePath = join(webDir, 'index.html')
			} else {
				// Remove /web prefix and normalize
				const relativePath = path.replace(/^\/web/, '')
				filePath = join(webDir, relativePath)
			}

			try {
				// Security: prevent directory traversal by resolving and checking the path
				const resolvedPath = resolve(filePath)
				const resolvedWebDir = resolve(webDir)
				if (!resolvedPath.startsWith(resolvedWebDir)) {
					sendJson(res, 403, { ok: false, error: 'forbidden' })
					return
				}

				const content = await readFile(resolvedPath)
				const ext = extname(resolvedPath)
				const contentType = MIME_TYPES[ext] || 'application/octet-stream'
				res.writeHead(200, { 'content-type': contentType })
				res.end(content)
				return
			} catch {
				// File not found, continue to 404
			}
		}

		// Web UI - send message (for clients without WebSocket)
		if (req.method === 'POST' && path === '/web/send') {
			try {
				const raw = await readBody(req)
				const payload = JSON.parse(raw) as { text: string; sessionId: string }
				const chatId = `web:${payload.sessionId}`

				// Create incoming message and broadcast to bridge
				const message: IncomingMessage = {
					id: `${chatId}:${Date.now()}`,
					chatId,
					userId: chatId,
					messageId: Date.now(),
					text: payload.text,
					timestamp: new Date().toISOString(),
					raw: payload,
				}

				broadcast({ type: 'message.received', payload: message })
				sendJson(res, 200, { ok: true })
			} catch (error) {
				const message = error instanceof Error ? error.message : 'unknown error'
				sendJson(res, 400, { ok: false, error: message })
			}
			return
		}

		// Web UI - streaming message
		if (req.method === 'POST' && path === '/web/stream') {
			try {
				const raw = await readBody(req)
				const payload = JSON.parse(raw) as {
					chatId: string
					action: 'start' | 'chunk' | 'end'
					text?: string
					inlineButtons?: { text: string; callbackData: string }[][]
				}

				const chatIdStr = String(payload.chatId)
				if (!chatIdStr.startsWith('web:')) {
					sendJson(res, 400, { ok: false, error: 'not a web client' })
					return
				}

				if (payload.action === 'start') {
					sendToWebClient(chatIdStr, { type: 'web.stream.start', payload: {} })
				} else if (payload.action === 'chunk' && payload.text) {
					sendToWebClient(chatIdStr, { type: 'web.stream.chunk', payload: { text: payload.text } })
				} else if (payload.action === 'end') {
					sendToWebClient(chatIdStr, {
						type: 'web.stream.end',
						payload: { text: payload.text, inlineButtons: payload.inlineButtons },
					})
				}

				sendJson(res, 200, { ok: true })
			} catch (error) {
				const message = error instanceof Error ? error.message : 'unknown error'
				sendJson(res, 400, { ok: false, error: message })
			}
			return
		}

		// Web UI - file upload
		if (req.method === 'POST' && path === '/web/upload') {
			try {
				// Parse multipart form data manually (simple implementation)
				const contentType = req.headers['content-type'] || ''
				if (!contentType.includes('multipart/form-data')) {
					sendJson(res, 400, { ok: false, error: 'expected multipart/form-data' })
					return
				}

				const boundary = contentType.split('boundary=')[1]
				if (!boundary) {
					sendJson(res, 400, { ok: false, error: 'missing boundary' })
					return
				}

				const chunks: Buffer[] = []
				for await (const chunk of req) {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
				}
				const body = Buffer.concat(chunks)

				// Simple multipart parsing
				const parts = body.toString('binary').split('--' + boundary)
				let text = ''
				let sessionId = ''
				const attachments: { type: 'document'; fileId: string; localPath: string; mimeType?: string }[] = []

				for (const part of parts) {
					if (part.includes('name="text"')) {
						const match = part.match(/\r\n\r\n([\s\S]*?)\r\n/)
						if (match) text = match[1]
					} else if (part.includes('name="sessionId"')) {
						const match = part.match(/\r\n\r\n([\s\S]*?)\r\n/)
						if (match) sessionId = match[1]
					} else if (part.includes('name="files"')) {
						const filenameMatch = part.match(/filename="([^"]+)"/)
						const contentTypeMatch = part.match(/Content-Type: ([^\r\n]+)/)
						if (filenameMatch) {
							const filename = filenameMatch[1]
							const mimeType = contentTypeMatch?.[1]
							const dataMatch = part.match(/\r\n\r\n([\s\S]*?)$/)
							if (dataMatch) {
								const fileData = Buffer.from(dataMatch[1], 'binary')
								const localDir = join(tmpdir(), 'agent-gateway-files')
								await mkdir(localDir, { recursive: true })
								const localPath = join(localDir, `web_${Date.now()}_${filename}`)
								const writeStream = createWriteStream(localPath)
								writeStream.write(fileData.slice(0, -2)) // Remove trailing \r\n
								writeStream.end()
								attachments.push({
									type: 'document',
									fileId: `web_${Date.now()}`,
									localPath,
									mimeType,
								})
							}
						}
					}
				}

				const chatId = `web:${sessionId}`
				const message: IncomingMessage = {
					id: `${chatId}:${Date.now()}`,
					chatId,
					userId: chatId,
					messageId: Date.now(),
					text: text || undefined,
					attachments: attachments.length > 0 ? attachments : undefined,
					timestamp: new Date().toISOString(),
					raw: { text, sessionId, attachments },
				}

				broadcast({ type: 'message.received', payload: message })
				sendJson(res, 200, { ok: true })
			} catch (error) {
				const message = error instanceof Error ? error.message : 'unknown error'
				void logToFile('error', 'web upload failed', { error: message })
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
		const url = new URL(req.url ?? '/', 'http://localhost')
		const path = url.pathname

		// Web client WebSocket connection
		if (path === '/events/web') {
			const sessionId = url.searchParams.get('session') || `anon_${Date.now()}`
			wss.handleUpgrade(req, socket, head, (ws) => {
				const chatId = `web:${sessionId}`
				const client: WebClient = { ws, sessionId, chatId }
				webClients.set(sessionId, client)

				console.log(`[web] Client connected: ${sessionId}`)

				ws.on('message', (data) => {
					try {
						const msg = JSON.parse(data.toString()) as { type: string; payload: unknown }
						handleWebClientMessage(client, msg)
					} catch (err) {
						console.error('[web] Failed to parse message:', err)
					}
				})

				ws.on('close', () => {
					webClients.delete(sessionId)
					console.log(`[web] Client disconnected: ${sessionId}`)
				})

				wss.emit('connection', ws, req)
			})
			return
		}

		// Bridge WebSocket connection
		if (path !== '/events' || !isAuthorized(req, config)) {
			socket.destroy()
			return
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit('connection', ws, req)
		})
	})

	// Handle messages from web clients
	const handleWebClientMessage = (client: WebClient, msg: { type: string; payload: unknown }) => {
		console.log(`[web] Message from ${client.sessionId}:`, msg.type)

		if (msg.type === 'web.send') {
			const payload = msg.payload as { text: string }
			const message: IncomingMessage = {
				id: `${client.chatId}:${Date.now()}`,
				chatId: client.chatId,
				userId: client.chatId,
				messageId: Date.now(),
				text: payload.text,
				timestamp: new Date().toISOString(),
				raw: payload,
			}
			broadcast({ type: 'message.received', payload: message })
		} else if (msg.type === 'web.callback') {
			const payload = msg.payload as { data: string; messageId: string }
			broadcast({
				type: 'callback.query',
				payload: {
					id: `web_${Date.now()}`,
					chatId: client.chatId,
					messageId: parseInt(payload.messageId.split('_')[1] || '0', 10),
					data: payload.data,
					userId: client.chatId,
				},
			})
		}
	}

	// Send message to a specific web client
	const sendToWebClient = (chatId: string, event: WebEvent) => {
		const sessionId = chatId.replace('web:', '')
		const client = webClients.get(sessionId)
		if (client && client.ws.readyState === WebSocket.OPEN) {
			client.ws.send(JSON.stringify(event))
		}
	}

	bot.on('callback_query', async (ctx) => {
		const callback = ctx.callbackQuery
		if (!callback || !callback.message) return

		const chatId = callback.message.chat.id
		const messageId = callback.message.message_id

		// Filter by allowed chat IDs if configured
		if (config.allowedChatIds && config.allowedChatIds.length > 0) {
			if (!config.allowedChatIds.includes(chatId)) {
				void logToFile('info', 'callback ignored from unauthorized chat', { chatId })
				return
			}
		}

		// Answer callback query immediately
		await bot.api.answerCallbackQuery(callback.id).catch(() => {})

		// Broadcast callback query event
		broadcast({
			type: 'callback.query',
			payload: {
				id: callback.id,
				chatId,
				messageId,
				data: callback.data || '',
				userId: callback.from.id,
			},
		})
	})

	bot.on('message', async (ctx) => {
		const chatId = ctx.message.chat.id

		// Filter by allowed chat IDs if configured
		if (config.allowedChatIds && config.allowedChatIds.length > 0) {
			if (!config.allowedChatIds.includes(chatId)) {
				void logToFile('info', 'message ignored from unauthorized chat', { chatId })
				return
			}
		}

		activeChats.add(chatId)
		lastActiveChatId = chatId
		const normalized = normalizeMessage(ctx.message)
		
		// Download attachments to local files
		if (normalized.attachments?.length) {
			for (const attachment of normalized.attachments) {
				try {
					const localPath = await downloadTelegramFile(bot, attachment.fileId, attachment.type)
					attachment.localPath = localPath
					void logToFile('info', 'downloaded attachment', { fileId: attachment.fileId, localPath })
				} catch (err) {
					const message = err instanceof Error ? err.message : 'unknown error'
					void logToFile('error', 'failed to download attachment', { fileId: attachment.fileId, error: message })
				}
			}
		}

		// Process voice/audio attachments (transcription)
		if (normalized.attachments) {
			for (const attachment of normalized.attachments) {
				if (isVoiceAttachment(attachment)) {
					try {
						const transcriptText = await processVoiceAttachment(bot, attachment)
						normalized.text = normalized.text
							? `${transcriptText}\n\n${normalized.text}`
							: transcriptText
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : 'unknown error'
						void logToFile('error', 'voice transcription failed', { fileId: attachment.fileId, error: errMsg })
						normalized.text = normalized.text
							? `[Voice note - transcription failed: ${errMsg}]\n\n${normalized.text}`
							: `[Voice note - transcription failed: ${errMsg}]`
					}
				}
			}
		}

		broadcast({ type: 'message.received', payload: normalized })
	})

	bot.catch((error) => {
		void logToFile('error', 'bot error', { error: error.message })
		broadcast({ type: 'error', payload: { message: error.message } })
	})

	await new Promise<void>((resolve) => {
		server.listen(config.port, config.host, () => resolve())
	})

	void bot.start()

	const notifyRestart = async () => {
		// Use allowedChatIds from config, or fall back to lastActiveChatId
		const chatIds = config.allowedChatIds?.length 
			? config.allowedChatIds 
			: lastActiveChatId ? [lastActiveChatId] : []
		
		for (const chatId of chatIds) {
			try {
				await bot.api.sendMessage(chatId, '🔄 Gateway restarted')
			} catch {
				// ignore errors during restart notification
			}
		}
	}

	const notifyError = async (chatId: number, message: string) => {
		try {
			await bot.api.sendMessage(chatId, `⚠️ ${message}`)
		} catch {
			// ignore errors during error notification
		}
	}

	return {
		startedAt,
		getConnections: () => wss.clients.size,
		notifyRestart,
		addMcpServer: (mcp: McpServerHandle) => {
			mcpServer = mcp
		},
		sendToWebClient: (chatId: string, event: { type: string; payload: unknown }) => {
			if (chatId.startsWith('web:')) {
				const sessionId = chatId.replace('web:', '')
				const client = webClients.get(sessionId)
				if (client && client.ws.readyState === WebSocket.OPEN) {
					client.ws.send(JSON.stringify(event))
				}
			}
		},
		isWebClient: (chatId: string | number) => String(chatId).startsWith('web:'),
		close: async () => {
			// Notify active chats about shutdown
			for (const chatId of activeChats) {
				await notifyError(chatId, 'Gateway disconnected').catch(() => {})
			}
			// Close web client connections
			for (const client of webClients.values()) {
				client.ws.close()
			}
			wss.close()
			await bot.stop()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		},
	}
}
