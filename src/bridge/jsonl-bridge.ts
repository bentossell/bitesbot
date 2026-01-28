import WebSocket from 'ws'
import type { GatewayEvent, IncomingMessage } from '../protocol/types.js'
import { type CLIManifest, loadAllManifests } from './manifest.js'
import {
	JsonlSession,
	createSessionStore,
	type SessionStore,
	type BridgeEvent,
} from './jsonl-session.js'
import { createPersistentSessionStore, setWorkspaceDir, type PersistentSessionStore } from './session-store.js'
import { syncSessionToMemory } from './memory-sync.js'
import { CronService, parseScheduleArg } from '../cron/index.js'
import { logToFile } from '../logging/file.js'

export type BridgeConfig = {
	gatewayUrl: string
	authToken?: string
	adaptersDir: string
	defaultCli: string
	workingDirectory: string
}

export type BridgeHandle = {
	close: () => void
	getManifests: () => Map<string, CLIManifest>
	getSessionStore: () => SessionStore
}

type CommandResult =
	| { handled: false }
	| { handled: true; response: string }
	| { handled: true; response: string; async: true }

type ParseCommandOptions = {
	text: string
	chatId: number | string
	manifests: Map<string, CLIManifest>
	defaultCli: string
	sessionStore: SessionStore
	workingDirectory: string
	cronService?: CronService
	persistentStore?: PersistentSessionStore
}

const parseCommand = async (opts: ParseCommandOptions): Promise<CommandResult> => {
	const { text, chatId, manifests, defaultCli, sessionStore, workingDirectory, cronService, persistentStore } = opts
	const trimmed = text.trim()

	if (trimmed.startsWith('/use ')) {
		const cli = trimmed.slice(5).trim().toLowerCase()
		const manifest = manifests.get(cli)
		if (!manifest) {
			const available = Array.from(manifests.keys()).join(', ')
			return { handled: true, response: `Unknown CLI: ${cli}. Available: ${available}` }
		}
		// Set active CLI directly instead of pending switch
		sessionStore.setActiveCli(chatId, cli)
		if (persistentStore) {
			await persistentStore.setActiveCli(chatId, cli)
		}
		return { handled: true, response: `Switched to ${cli}.` }
	}

	if (trimmed === '/new') {
		// Sync session to memory before clearing
		try {
			const result = await syncSessionToMemory(workingDirectory)
			if (result.written) {
				console.log(`[jsonl-bridge] Synced ${result.entries} messages to memory`)
			}
		} catch (err) {
			console.error('[jsonl-bridge] Failed to sync memory on /new:', err)
		}
		
		const session = sessionStore.get(chatId)
		if (session) {
			session.terminate()
			sessionStore.delete(chatId)
		}
		return { handled: true, response: '💾 Session saved to memory. Starting fresh.' }
	}

	if (trimmed === '/stop') {
		const session = sessionStore.get(chatId)
		if (session) {
			session.terminate()
			sessionStore.delete(chatId)
			return { handled: true, response: '🛑 Session stopped.' }
		}
		return { handled: true, response: 'No active session to stop.' }
	}

	if (trimmed === '/status') {
		const session = sessionStore.get(chatId)
		const currentCli = sessionStore.getActiveCli(chatId) || session?.cli || defaultCli
		const resumeToken = sessionStore.getResumeToken(chatId, currentCli)
		if (!session && !resumeToken) {
			return { handled: true, response: `No active session. CLI: ${currentCli}` }
		}
		const info = session?.getInfo()
		const lines = [
			`CLI: ${currentCli}`,
			`State: ${info?.state || 'ready'}`,
		]
		if (resumeToken) {
			lines.push(`Resume: ${resumeToken.sessionId.slice(0, 8)}...`)
		}
		return { handled: true, response: lines.join('\n') }
	}

	// Cron commands
	if (cronService && trimmed.startsWith('/cron')) {
		const args = trimmed.slice(5).trim()

		if (args === '' || args === 'list') {
			const jobs = await cronService.list()
			return { handled: true, response: cronService.formatJobList(jobs) }
		}

		// /cron add "name" every 30m
		// /cron add "name" cron "0 9 * * *"
		const addMatch = args.match(/^add\s+"([^"]+)"\s+(.+)$/i)
		if (addMatch) {
			const [, name, scheduleArg] = addMatch
			const schedule = parseScheduleArg(scheduleArg)
			if (!schedule) {
				return { handled: true, response: `Invalid schedule: ${scheduleArg}\nExamples: every 30m, every 1h, cron "0 9 * * *"` }
			}
			const job = await cronService.add({ name, schedule })
			return { handled: true, response: `Created job: ${job.id}\n${name}\nNext run: ${job.nextRunAtMs ? new Date(job.nextRunAtMs).toLocaleString() : 'n/a'}` }
		}

		// /cron remove <id>
		const removeMatch = args.match(/^remove\s+(\S+)$/i)
		if (removeMatch) {
			const removed = await cronService.remove(removeMatch[1])
			return { handled: true, response: removed ? `Removed job: ${removeMatch[1]}` : `Job not found: ${removeMatch[1]}` }
		}

		// /cron run <id>
		const runMatch = args.match(/^run\s+(\S+)$/i)
		if (runMatch) {
			const job = await cronService.run(runMatch[1])
			return { handled: true, response: job ? `Running job: ${job.name}` : `Job not found: ${runMatch[1]}` }
		}

		// /cron enable/disable <id>
		const enableMatch = args.match(/^(enable|disable)\s+(\S+)$/i)
		if (enableMatch) {
			const [, action, id] = enableMatch
			const enabled = action.toLowerCase() === 'enable'
			const success = await cronService.enable(id, enabled)
			return { handled: true, response: success ? `Job ${id} ${enabled ? 'enabled' : 'disabled'}` : `Job not found: ${id}` }
		}

		return { handled: true, response: `Unknown cron command. Usage:\n/cron list\n/cron add "name" every 30m\n/cron add "name" cron "0 9 * * *"\n/cron remove <id>\n/cron run <id>\n/cron enable <id>\n/cron disable <id>` }
	}

	return { handled: false }
}

const sendToGateway = async (
	baseUrl: string,
	authToken: string | undefined,
	chatId: number | string,
	text: string
) => {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (authToken) {
		headers.Authorization = `Bearer ${authToken}`
	}

	const httpUrl = baseUrl.replace(/^ws/, 'http').replace('/events', '')
	try {
		const response = await fetch(`${httpUrl}/send`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ chatId, text }),
		})
		if (!response.ok) {
			const body = await response.text().catch(() => '')
			void logToFile('error', 'bridge send non-200', {
				status: response.status,
				chatId,
				body: body.slice(0, 1000),
			})
		}
	} catch (err) {
		console.error(`[jsonl-bridge] Failed to send message:`, err)
		const message = err instanceof Error ? err.message : 'unknown error'
		void logToFile('error', 'bridge send failed', { error: message, chatId })
	}
}

const sendTyping = async (
	baseUrl: string,
	authToken: string | undefined,
	chatId: number | string
) => {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (authToken) {
		headers.Authorization = `Bearer ${authToken}`
	}

	const httpUrl = baseUrl.replace(/^ws/, 'http').replace('/events', '')
	try {
		await fetch(`${httpUrl}/typing`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ chatId }),
		})
	} catch {
		// ignore typing errors
	}
}

const formatToolName = (name: string): string => {
	const icons: Record<string, string> = {
		Read: '📖',
		Write: '✏️',
		Edit: '✏️',
		Execute: '⚡',
		Bash: '⚡',
		Grep: '🔍',
		Glob: '🔍',
		LS: '📁',
		Create: '📝',
		Task: '🤖',
		WebSearch: '🌐',
		FetchUrl: '🌐',
	}
	return `${icons[name] || '🔧'} ${name}`
}

export const startBridge = async (config: BridgeConfig): Promise<BridgeHandle> => {
	const manifests = await loadAllManifests(config.adaptersDir)
	if (manifests.size === 0) {
		console.warn('[jsonl-bridge] No CLI adapters found in', config.adaptersDir)
	}

	const sessionStore = createSessionStore()
	const persistentStore = await createPersistentSessionStore()
	const cronService = new CronService()
	await cronService.start()
	
	console.log(`[jsonl-bridge] Loaded ${persistentStore.resumeTokens.size} resume tokens`)

	// Sync session logs to memory on startup (gateway restart)
	try {
		const result = await syncSessionToMemory(config.workingDirectory)
		if (result.written) {
			console.log(`[jsonl-bridge] Synced ${result.entries} messages to memory on startup`)
		}
	} catch (err) {
		console.error('[jsonl-bridge] Failed to sync memory on startup:', err)
	}

	const wsUrl = config.gatewayUrl.replace(/^http/, 'ws')
	const wsEndpoint = wsUrl.endsWith('/events') ? wsUrl : `${wsUrl}/events`

	const headers: Record<string, string> = {}
	if (config.authToken) {
		headers.Authorization = `Bearer ${config.authToken}`
	}

	const ws = new WebSocket(wsEndpoint, { headers })

	const send = (chatId: number | string, text: string) =>
		sendToGateway(config.gatewayUrl, config.authToken, chatId, text)

	const typing = (chatId: number | string) =>
		sendTyping(config.gatewayUrl, config.authToken, chatId)

	// Track the primary chat for cron job delivery
	let primaryChatId: number | string | null = null

	const handleMessage = async (message: IncomingMessage) => {
		const { chatId, text, attachments } = message
		if (!text && !attachments?.length) return
		const t0 = Date.now()
		
		// Build prompt with image paths if present
		let prompt = text || ''
		if (attachments?.length) {
			const imagePaths = attachments
				.filter(a => a.localPath)
				.map(a => a.localPath)
			if (imagePaths.length) {
				// Prepend image paths so the CLI can read them
				const imageNote = imagePaths.map(p => `[Image: ${p}]`).join(' ')
				prompt = prompt ? `${imageNote}\n\n${prompt}` : imageNote
			}
		}

		// Remember the chat for cron delivery
		if (!primaryChatId) {
			primaryChatId = chatId
		}

		console.log(`[jsonl-bridge] [${Date.now() - t0}ms] Received from ${chatId}: "${prompt.slice(0, 50)}..."`)

		const cmdResult = await parseCommand({
			text: prompt,
			chatId,
			manifests,
			defaultCli: config.defaultCli,
			sessionStore,
			workingDirectory: config.workingDirectory,
			cronService,
			persistentStore,
		})
		if (cmdResult.handled) {
			console.log(`[jsonl-bridge] Command handled: ${text}`)
			await send(chatId, cmdResult.response)
			return
		}

		// Use active CLI for this chat, or default (check persistent store first)
		const cliName = persistentStore.getActiveCli(chatId) || sessionStore.getActiveCli(chatId) || config.defaultCli
		
		// Log user message
		void persistentStore.logMessage(chatId, 'user', prompt, undefined, cliName)
		const manifest = manifests.get(cliName)
		if (!manifest) {
			console.log(`[jsonl-bridge] CLI '${cliName}' not found`)
			await send(chatId, `CLI '${cliName}' not found. Check adapters directory.`)
			return
		}

		// Get existing resume token for this specific CLI
		const resumeToken = sessionStore.getResumeToken(chatId, cliName)

		console.log(`[jsonl-bridge] [${Date.now() - t0}ms] Starting ${cliName} session for ${chatId}${resumeToken ? ' (resuming)' : ''}`)

		// Start typing immediately (before CLI spawns)
		let typingInterval: ReturnType<typeof setInterval> | null = null
		void typing(chatId)
		typingInterval = setInterval(() => void typing(chatId), 4000)

		const stopTypingLoop = () => {
			if (typingInterval) {
				clearInterval(typingInterval)
				typingInterval = null
			}
		}

		const session = new JsonlSession(chatId, manifest, config.workingDirectory)
		sessionStore.set(session)

		let lastToolStatus: string | null = null

		session.on('event', async (evt: BridgeEvent) => {
			switch (evt.type) {
				case 'started':
					console.log(`[jsonl-bridge] [${Date.now() - t0}ms] Session started: ${evt.sessionId}`)
					sessionStore.setResumeToken(chatId, cliName, { engine: cliName, sessionId: evt.sessionId })
					break

				case 'thinking':
					if (evt.text) {
						const preview = evt.text.length > 100 ? evt.text.slice(0, 100) + '...' : evt.text
						await send(chatId, `💭 ${preview}`)
					}
					break

				case 'tool_start': {
					const status = formatToolName(evt.name)
					if (status !== lastToolStatus) {
						lastToolStatus = status
						await send(chatId, status)
					}
					break
				}

				case 'tool_end':
					if (evt.isError) {
						await send(chatId, `❌ Tool failed`)
					}
					break

				case 'completed':
					stopTypingLoop()
					console.log(`[jsonl-bridge] Completed: ${evt.sessionId}`)
					sessionStore.setResumeToken(chatId, cliName, { engine: cliName, sessionId: evt.sessionId })
					// Persist resume token and log assistant response
					void persistentStore.setResumeToken(chatId, cliName, { engine: cliName, sessionId: evt.sessionId })
					if (evt.answer) {
						void persistentStore.logMessage(chatId, 'assistant', evt.answer, evt.sessionId, cliName)
						const chunks = splitMessage(evt.answer)
						for (const chunk of chunks) {
							await send(chatId, chunk)
						}
					}
					if (evt.cost) {
						await send(chatId, `💰 Cost: $${evt.cost.toFixed(4)}`)
					}
					break

				case 'error':
					stopTypingLoop()
					await send(chatId, `❌ ${evt.message}`)
					break
			}
		})

		session.on('exit', (code) => {
			stopTypingLoop()
			console.log(`[jsonl-bridge] Session exited with code ${code}`)
			sessionStore.delete(chatId)
		})

		// Run with resume token if we have one
		session.run(prompt, resumeToken)
	}

	ws.on('message', (data) => {
		try {
			const event = JSON.parse(data.toString()) as GatewayEvent
			if (event.type === 'message.received') {
				void handleMessage(event.payload)
			}
		} catch {
			// ignore
		}
	})

	ws.on('error', (err) => {
		console.error('[jsonl-bridge] WebSocket error:', err.message)
	})

	ws.on('close', () => {
		console.log('[jsonl-bridge] Disconnected from gateway')
	})

	ws.on('open', () => {
		console.log('[jsonl-bridge] Connected to gateway')
	})

	// Handle cron job triggers
	cronService.on('event', async (evt) => {
		if (evt.type !== 'job:due') return
		if (!primaryChatId) {
			console.log('[jsonl-bridge] Cron job due but no primary chat set')
			return
		}

		console.log(`[jsonl-bridge] Cron job triggered: ${evt.job.name}`)
		await send(primaryChatId, `⏰ Cron: ${evt.job.name}`)

		// Send the job message as if it came from the user
		void handleMessage({
			id: `cron-${Date.now()}`,
			chatId: primaryChatId,
			text: evt.job.message,
			userId: 'cron',
			messageId: 0,
			timestamp: new Date().toISOString(),
			raw: { cron: true, jobId: evt.job.id },
		})
	})

	return {
		close: () => {
			cronService.stop()
			ws.close()
			for (const session of sessionStore.sessions.values()) {
				session.terminate()
			}
		},
		getManifests: () => manifests,
		getSessionStore: () => sessionStore,
	}
}

const splitMessage = (text: string, maxLength = 4000): string[] => {
	if (text.length <= maxLength) return [text]

	const chunks: string[] = []
	let remaining = text

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining)
			break
		}

		let splitAt = remaining.lastIndexOf('\n', maxLength)
		if (splitAt === -1 || splitAt < maxLength / 2) {
			splitAt = maxLength
		}

		chunks.push(remaining.slice(0, splitAt))
		remaining = remaining.slice(splitAt).trimStart()
	}

	return chunks
}
