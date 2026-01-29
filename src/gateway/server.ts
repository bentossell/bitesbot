import { createServer } from 'node:http'
import type { IncomingMessage as HttpIncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, readdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { Bot, InputFile } from 'grammy'
import { WebSocketServer } from 'ws'
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
} from '../protocol/types.js'
import { PROTOCOL_VERSION } from '../protocol/types.js'

export type GatewayServerHandle = {
	close: () => Promise<void>
	startedAt: Date
	getConnections: () => number
	notifyRestart: () => Promise<void>
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

const TEMP_DIR = join(tmpdir(), 'agent-gateway-files')
const TEMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const cleanupTempFiles = async (): Promise<void> => {
	try {
		const entries = await readdir(TEMP_DIR, { withFileTypes: true })
		const now = Date.now()
		await Promise.all(entries.map(async (entry) => {
			if (!entry.isFile()) return
			const filePath = join(TEMP_DIR, entry.name)
			try {
				const stats = await stat(filePath)
				if (now - stats.mtimeMs > TEMP_MAX_AGE_MS) {
					await unlink(filePath)
				}
			} catch {
				// ignore per-file errors
			}
		}))
	} catch {
		// ignore cleanup errors
	}
}

// Download a Telegram file to local temp directory
const downloadTelegramFile = async (bot: Bot, fileId: string, type: 'photo' | 'document' | 'voice' | 'audio'): Promise<string> => {
	const file = await bot.api.getFile(fileId)
	if (!file.file_path) {
		throw new Error('No file_path returned from Telegram')
	}
	
	const extMap: Record<string, string> = { photo: 'jpg', voice: 'ogg', audio: 'mp3' }
	const ext = extMap[type] ?? (file.file_path.split('.').pop() || 'bin')
	await mkdir(TEMP_DIR, { recursive: true })
	const localPath = join(TEMP_DIR, `${fileId}.${ext}`)
	
	const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`
	const response = await fetch(fileUrl)
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download file: ${response.status}`)
	}
	
	const writeStream = createWriteStream(localPath)
	const webStream = response.body as WebReadableStream<Uint8Array>
	await pipeline(Readable.fromWeb(webStream), writeStream)
	
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

export const startGatewayServer = async (config: GatewayConfig): Promise<GatewayServerHandle> => {
	const bot = new Bot(config.botToken)
	const startedAt = new Date()
	void cleanupTempFiles()
	const cleanupTimer = setInterval(() => void cleanupTempFiles(), 6 * 60 * 60 * 1000)
	let botInfo: Awaited<ReturnType<typeof bot.api.getMe>> | undefined
	const activeChats = new Set<number>()
	let lastActiveChatId: number | undefined

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
				}).catch(() => {})
				broadcast({ type: 'error', payload: { message } })
				sendJson(res, 400, { ok: false, error: message })
			}
			return
		}

		if (req.method === 'POST' && path === '/typing') {
			try {
				const raw = await readBody(req)
				const payload = JSON.parse(raw) as TypingRequest
				const chatId = typeof payload.chatId === 'string' ? Number.parseInt(payload.chatId, 10) : payload.chatId
				await bot.api.sendChatAction(chatId, 'typing')
				sendJson(res, 200, { ok: true })
			} catch (error) {
				const message = error instanceof Error ? error.message : 'unknown error'
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

	bot.on('callback_query', async (ctx) => {
		const callback = ctx.callbackQuery
		if (!callback || !callback.message) return

		const chatId = callback.message.chat.id
		const messageId = callback.message.message_id

		// Filter by allowed chat IDs if configured
		if (config.allowedChatIds && config.allowedChatIds.length > 0) {
			if (!config.allowedChatIds.includes(chatId)) {
				void logToFile('info', 'callback ignored from unauthorized chat', { chatId }).catch(() => {})
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
				void logToFile('info', 'message ignored from unauthorized chat', { chatId }).catch(() => {})
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
					void logToFile('info', 'downloaded attachment', { fileId: attachment.fileId, localPath }).catch(() => {})
				} catch (err) {
					const message = err instanceof Error ? err.message : 'unknown error'
					void logToFile('error', 'failed to download attachment', { fileId: attachment.fileId, error: message }).catch(() => {})
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
						void logToFile('error', 'voice transcription failed', { fileId: attachment.fileId, error: errMsg }).catch(() => {})
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
		void logToFile('error', 'bot error', { error: error.message }).catch(() => {})
		broadcast({ type: 'error', payload: { message: error.message } })
	})

	await new Promise<void>((resolve) => {
		server.listen(config.port, config.host, () => resolve())
	})

	void bot.start().catch(() => {})

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
		close: async () => {
			// Notify active chats about shutdown
			for (const chatId of activeChats) {
				await notifyError(chatId, 'Gateway disconnected').catch(() => {})
			}
			clearInterval(cleanupTimer)
			wss.close()
			await bot.stop()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		},
	}
}
