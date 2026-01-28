import WebSocket from 'ws'
import type { GatewayEvent, IncomingMessage } from '../protocol/types.js'
import { type CLIManifest, loadAllManifests } from './manifest.js'
import {
	JsonlSession,
	createSessionStore,
	type SessionStore,
	type BridgeEvent,
	type QueuedMessage,
} from './jsonl-session.js'
import { createPersistentSessionStore, type PersistentSessionStore } from './session-store.js'
import { syncSessionToMemory } from './memory-sync.js'
import { CronService, parseScheduleArg } from '../cron/index.js'
import { logToFile } from '../logging/file.js'
import {
	subagentRegistry,
	type SubagentRunRecord,
	saveSubagentRegistry,
	loadSubagentRegistry,
	formatPendingResultsForInjection,
} from './subagent-registry.js'
import {
	parseSpawnCommand,
	parseSubagentsCommand,
	formatSubagentList,
	formatSubagentAnnouncement,
	findSubagent,
} from './subagent-commands.js'

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
		const stoppedSubagents = subagentRegistry.stopAll(chatId)
		if (session) {
			session.terminate()
			sessionStore.delete(chatId)
			const subagentMsg = stoppedSubagents > 0 ? ` + ${stoppedSubagents} subagent(s)` : ''
			return { handled: true, response: `🛑 Session stopped${subagentMsg}.` }
		}
		if (stoppedSubagents > 0) {
			return { handled: true, response: `🛑 Stopped ${stoppedSubagents} subagent(s).` }
		}
		return { handled: true, response: 'No active session to stop.' }
	}

	if (trimmed === '/status') {
		const session = sessionStore.get(chatId)
		const currentCli = sessionStore.getActiveCli(chatId) || session?.cli || defaultCli
		const resumeToken = sessionStore.getResumeToken(chatId, currentCli)
		const settings = persistentStore?.getChatSettings(chatId) ?? { streaming: false, verbose: false }
		if (!session && !resumeToken) {
			return { handled: true, response: `No active session. CLI: ${currentCli}\nStreaming: ${settings.streaming ? 'on' : 'off'}\nVerbose: ${settings.verbose ? 'on' : 'off'}` }
		}
		const info = session?.getInfo()
		const lines = [
			`CLI: ${currentCli}`,
			`State: ${info?.state || 'ready'}`,
			`Streaming: ${settings.streaming ? 'on' : 'off'}`,
			`Verbose: ${settings.verbose ? 'on' : 'off'}`,
		]
		if (resumeToken) {
			lines.push(`Resume: ${resumeToken.sessionId.slice(0, 8)}...`)
		}
		return { handled: true, response: lines.join('\n') }
	}

	if (trimmed === '/stream' || trimmed === '/stream on' || trimmed === '/stream off') {
		if (!persistentStore) {
			return { handled: true, response: 'Settings not available.' }
		}
		const current = persistentStore.getChatSettings(chatId)
		const newValue = trimmed === '/stream off' ? false : trimmed === '/stream on' ? true : !current.streaming
		await persistentStore.setChatSettings(chatId, { streaming: newValue })
		return { handled: true, response: `Streaming ${newValue ? 'enabled' : 'disabled'}. Text will be sent ${newValue ? 'as it arrives' : 'when complete'}.` }
	}

	if (trimmed === '/verbose' || trimmed === '/verbose on' || trimmed === '/verbose off') {
		if (!persistentStore) {
			return { handled: true, response: 'Settings not available.' }
		}
		const current = persistentStore.getChatSettings(chatId)
		const newValue = trimmed === '/verbose off' ? false : trimmed === '/verbose on' ? true : !current.verbose
		await persistentStore.setChatSettings(chatId, { verbose: newValue })
		return { handled: true, response: `Verbose ${newValue ? 'enabled' : 'disabled'}. Tool ${newValue ? 'names and outputs will be shown' : 'details hidden'}.` }
	}

	// Subagent commands - /spawn handled async in bridge, return signal here
	if (trimmed.startsWith('/spawn')) {
		const parsed = parseSpawnCommand(trimmed)
		if (!parsed) {
			return { handled: true, response: 'Usage: /spawn "task"\n       /spawn --label "Name" "task"\n       /spawn --cli droid "task"' }
		}
		// Signal that this is a spawn command - actual spawning handled in bridge
		return { handled: true, response: '__SPAWN__', async: true }
	}

	// /subagents command
	if (trimmed.startsWith('/subagents')) {
		const parsed = parseSubagentsCommand(trimmed)
		if (!parsed) {
			return { handled: true, response: 'Usage:\n/subagents\n/subagents list\n/subagents stop <id>\n/subagents stop all\n/subagents log <id>' }
		}

		switch (parsed.action) {
			case 'list': {
				const records = subagentRegistry.list(chatId)
				return { handled: true, response: formatSubagentList(records) }
			}
			case 'stop-all': {
				const count = subagentRegistry.stopAll(chatId)
				return { handled: true, response: count > 0 ? `🛑 Stopped ${count} subagent(s).` : 'No active subagents.' }
			}
			case 'stop': {
				const record = findSubagent(chatId, parsed.target)
				if (!record) {
					return { handled: true, response: `Subagent not found: ${parsed.target}` }
				}
				subagentRegistry.stop(record.runId)
				return { handled: true, response: `🛑 Stopped: ${record.label || record.runId.slice(0, 8)}` }
			}
			case 'log': {
				const record = findSubagent(chatId, parsed.target)
				if (!record) {
					return { handled: true, response: `Subagent not found: ${parsed.target}` }
				}
				const output = record.result || record.error || '(no output yet)'
				return { handled: true, response: `📋 ${record.label || record.runId.slice(0, 8)}:\n\n${output}` }
			}
		}
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

type SpawnSubagentOptions = {
	chatId: number | string
	task: string
	label?: string
	cli?: string
	manifests: Map<string, CLIManifest>
	defaultCli: string
	workingDirectory: string
	send: (chatId: number | string, text: string) => Promise<void>
}

const spawnSubagent = async (opts: SpawnSubagentOptions): Promise<void> => {
	const { chatId, task, label, manifests, defaultCli, workingDirectory, send } = opts
	const cliName = opts.cli || defaultCli

	// Check concurrency limit
	if (!subagentRegistry.canSpawn(chatId)) {
		await send(chatId, '⚠️ Too many subagents running. Stop some first with /subagents stop all')
		return
	}

	const manifest = manifests.get(cliName)
	if (!manifest) {
		await send(chatId, `❌ CLI not found: ${cliName}`)
		return
	}

	// Register the run
	const record = subagentRegistry.spawn({
		chatId,
		task,
		cli: cliName,
		label,
	})

	const displayName = label || `Subagent #${record.runId.slice(0, 8)}`
	await send(chatId, `🚀 Spawned: ${displayName}\n   CLI: ${cliName}\n   Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`)

	console.log(`[jsonl-bridge] Spawning subagent ${record.runId} with ${cliName}: "${task.slice(0, 50)}..."`)

	// Create a new session for the subagent (no resume - fresh context)
	const session = new JsonlSession(`subagent-${record.runId}`, manifest, workingDirectory)

	let lastText = ''

	session.on('event', (evt: BridgeEvent) => {
		switch (evt.type) {
			case 'started':
				subagentRegistry.markRunning(record.runId, evt.sessionId)
				console.log(`[jsonl-bridge] Subagent ${record.runId} started: ${evt.sessionId}`)
				break

			case 'text':
				if (evt.text) {
					lastText = evt.text
				}
				break

			case 'completed':
				console.log(`[jsonl-bridge] Subagent ${record.runId} completed`)
				subagentRegistry.markCompleted(record.runId, evt.answer || lastText)
				// Announce completion
				void send(chatId, formatSubagentAnnouncement(subagentRegistry.get(record.runId)!))
				// Prune old runs and persist
				subagentRegistry.prune(chatId)
				void saveSubagentRegistry()
				break

			case 'error':
				console.log(`[jsonl-bridge] Subagent ${record.runId} error: ${evt.message}`)
				subagentRegistry.markError(record.runId, evt.message)
				void send(chatId, formatSubagentAnnouncement(subagentRegistry.get(record.runId)!))
				void saveSubagentRegistry()
				break
		}
	})

	session.on('exit', (code) => {
		console.log(`[jsonl-bridge] Subagent ${record.runId} exited with code ${code}`)
		// If exited without completing, mark as error
		const current = subagentRegistry.get(record.runId)
		if (current && current.status === 'running') {
			subagentRegistry.markError(record.runId, `Process exited with code ${code}`)
			void send(chatId, formatSubagentAnnouncement(subagentRegistry.get(record.runId)!))
		}
	})

	// Run the subagent (no resume token - fresh session)
	session.run(task)
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

	// Load subagent registry from disk
	const subagentCount = await loadSubagentRegistry()
	if (subagentCount > 0) {
		console.log(`[jsonl-bridge] Restored ${subagentCount} subagent records`)
	}

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

	const processMessage = async (chatId: number | string, prompt: string, attachments?: IncomingMessage['attachments']) => {
		const t0 = Date.now()

		// Use active CLI for this chat, or default (check persistent store first)
		const cliName = persistentStore.getActiveCli(chatId) || sessionStore.getActiveCli(chatId) || config.defaultCli
		
		// Inject any pending subagent results into the prompt
		const pendingResults = formatPendingResultsForInjection(chatId)
		if (pendingResults) {
			prompt = `${pendingResults}\n\n${prompt}`
			console.log(`[jsonl-bridge] Injected subagent results into prompt`)
		}

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

		// Get chat settings dynamically (allows mid-session changes via /stream and /verbose)
		const getSettings = () => persistentStore.getChatSettings(chatId)
		let lastToolStatus: string | null = null
		let streamBuffer = ''
		let streamTimer: ReturnType<typeof setTimeout> | null = null
		const streamedTexts = new Set<string>()
		const STREAM_MIN_CHARS = 800
		const STREAM_IDLE_MS = 1500

		const flushStreamBuffer = async (force = false) => {
			if (streamTimer) {
				clearTimeout(streamTimer)
				streamTimer = null
			}
			if (!streamBuffer || (!force && streamBuffer.length < STREAM_MIN_CHARS)) return
			
			const toSend = streamBuffer.trim()
			streamBuffer = ''
			if (toSend && !streamedTexts.has(toSend)) {
				streamedTexts.add(toSend)
				await send(chatId, toSend)
			}
		}

		const scheduleStreamFlush = () => {
			if (streamTimer) clearTimeout(streamTimer)
			streamTimer = setTimeout(() => void flushStreamBuffer(true), STREAM_IDLE_MS)
		}

		session.on('event', async (evt: BridgeEvent) => {
			switch (evt.type) {
				case 'started':
					console.log(`[jsonl-bridge] [${Date.now() - t0}ms] Session started: ${evt.sessionId}`)
					sessionStore.setResumeToken(chatId, cliName, { engine: cliName, sessionId: evt.sessionId })
					break

				case 'thinking':
					// Thinking is not sent to user
					break

				case 'text':
					// Handle streaming text if enabled (check dynamically)
					if (getSettings().streaming && evt.text) {
						streamBuffer = evt.text
						if (streamBuffer.length >= STREAM_MIN_CHARS) {
							await flushStreamBuffer(true)
						} else {
							scheduleStreamFlush()
						}
					}
					break

				case 'tool_start': {
					if (getSettings().verbose) {
						const status = formatToolName(evt.name)
						if (status !== lastToolStatus) {
							lastToolStatus = status
							await send(chatId, status)
						}
					}
					break
				}

				case 'tool_end':
					if (getSettings().verbose) {
						if (evt.isError) {
							await send(chatId, `❌ Tool failed`)
						} else if (evt.preview) {
							const preview = evt.preview.length > 200 ? evt.preview.slice(0, 200) + '...' : evt.preview
							await send(chatId, `📤 ${preview}`)
						}
					}
					break

				case 'completed':
					stopTypingLoop()
					if (streamTimer) {
						clearTimeout(streamTimer)
						streamTimer = null
					}
					console.log(`[jsonl-bridge] Completed: ${evt.sessionId}`)
					sessionStore.setResumeToken(chatId, cliName, { engine: cliName, sessionId: evt.sessionId })
					void persistentStore.setResumeToken(chatId, cliName, { engine: cliName, sessionId: evt.sessionId })
					if (evt.answer) {
						void persistentStore.logMessage(chatId, 'assistant', evt.answer, evt.sessionId, cliName)
						// If streaming was on, check if we already sent this content
						if (getSettings().streaming && streamedTexts.has(evt.answer.trim())) {
							// Already sent via streaming
						} else {
							const chunks = splitMessage(evt.answer)
							for (const chunk of chunks) {
								if (!streamedTexts.has(chunk.trim())) {
									await send(chatId, chunk)
								}
							}
						}
					}
					if (evt.cost) {
						await send(chatId, `💰 Cost: $${evt.cost.toFixed(4)}`)
					}
					break

				case 'error':
					stopTypingLoop()
					if (streamTimer) {
						clearTimeout(streamTimer)
						streamTimer = null
					}
					await send(chatId, `❌ ${evt.message}`)
					break
			}
		})

		session.on('exit', (code) => {
			stopTypingLoop()
			console.log(`[jsonl-bridge] Session exited with code ${code}`)
			sessionStore.delete(chatId)
			// Flush queue after session ends
			void flushQueue(chatId)
		})

		// Run with resume token if we have one
		session.run(prompt, resumeToken)
	}

	const flushQueue = async (chatId: number | string) => {
		const next = sessionStore.dequeue(chatId)
		if (!next) return
		console.log(`[jsonl-bridge] Flushing queued message for ${chatId}`)
		await processMessage(chatId, next.text, next.attachments as IncomingMessage['attachments'])
	}

	const handleMessage = async (message: IncomingMessage) => {
		const { chatId, text, attachments } = message
		if (!text && !attachments?.length) return

		// Build prompt with image paths if present
		let prompt = text || ''
		if (attachments?.length) {
			const imagePaths = attachments
				.filter(a => a.localPath)
				.map(a => a.localPath)
			if (imagePaths.length) {
				const imageNote = imagePaths.map(p => `[Image: ${p}]`).join(' ')
				prompt = prompt ? `${imageNote}\n\n${prompt}` : imageNote
			}
		}

		// Remember the chat for cron delivery
		if (!primaryChatId) {
			primaryChatId = chatId
		}

		console.log(`[jsonl-bridge] Received from ${chatId}: "${prompt.slice(0, 50)}..."`)

		// Handle commands (always process immediately)
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
			if ('async' in cmdResult && cmdResult.response === '__SPAWN__') {
				const spawnCmd = parseSpawnCommand(prompt)
				if (spawnCmd) {
					void spawnSubagent({
						chatId,
						task: spawnCmd.task,
						label: spawnCmd.label,
						cli: spawnCmd.cli,
						manifests,
						defaultCli: config.defaultCli,
						workingDirectory: config.workingDirectory,
						send,
					})
					return
				}
			}
			console.log(`[jsonl-bridge] Command handled: ${text}`)
			await send(chatId, cmdResult.response)
			return
		}

		// Check if busy - queue message if so
		if (sessionStore.isBusy(chatId)) {
			const queueLen = sessionStore.getQueueLength(chatId)
			if (queueLen >= 5) {
				await send(chatId, '⚠️ Queue full (5 messages). Wait for current task or /stop.')
				return
			}
			sessionStore.enqueue(chatId, {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				text: prompt,
				attachments: attachments?.map(a => ({ localPath: a.localPath })),
				createdAt: Date.now(),
			})
			await send(chatId, `📥 Queued (${queueLen + 1} pending). Will process after current task.`)
			return
		}

		await processMessage(chatId, prompt, attachments)
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
