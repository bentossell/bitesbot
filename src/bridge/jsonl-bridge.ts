import WebSocket from 'ws'
import type { GatewayEvent, IncomingMessage, CallbackQuery } from '../protocol/types.js'
import type { Plan } from '../protocol/plan-types.js'
import { type CLIManifest, loadAllManifests } from './manifest.js'
import {
	JsonlSession,
	createSessionStore,
	type SessionStore,
	type BridgeEvent,
} from './jsonl-session.js'
import { createPersistentSessionStore, type PersistentSessionStore } from './session-store.js'
import { syncSessionToMemory } from './memory-sync.js'
import { CronService, parseScheduleArg } from '../cron/index.js'
import { logToFile } from '../logging/file.js'
import {
	subagentRegistry,
	saveSubagentRegistry,
	loadSubagentRegistry,
	formatPendingResultsForInjection,
} from './subagent-registry.js'
import {
	CommandLane,
	enqueueCommandInLane,
	initDefaultLanes,
} from './command-queue.js'
import {
	parseSpawnCommand,
	parseNaturalSpawnRequest,
	parseSubagentsCommand,
	formatSubagentList,
	formatSubagentAnnouncement,
	findSubagent,
} from './subagent-commands.js'
import {
	storePendingPlan,
	getPendingPlan,
	removePendingPlan,
	formatPlanForDisplay,
} from './plan-approval-store.js'
import {
	setSpecMode,
	getSpecMode,
	clearSpecMode,
	isInSpecMode,
	setPendingPlan,
	detectIntent,
} from './spec-mode-store.js'
import { createConceptsIndex, getRelatedFilesForTerms } from '../workspace/concepts-index.js'
import {
	extractConceptsFromText,
	getRepoNames,
	loadConceptConfig,
	normalizeConcept,
	normalizeConceptConfig,
	normalizeConceptToken,
	saveConceptConfig,
} from '../workspace/concepts.js'
import { getRelativePath } from '../workspace/path-utils.js'

export type BridgeConfig = {
	gatewayUrl: string
	authToken?: string
	adaptersDir: string
	defaultCli: string
	workingDirectory: string
	allowedChatIds?: number[]
}

export type BridgeHandle = {
	close: () => void
	getManifests: () => Map<string, CLIManifest>
	getSessionStore: () => SessionStore
	spawnSubagentForMcp: (opts: {
		chatId: number | string
		task: string
		label?: string
		cli?: string
	}) => Promise<{ runId: string; status: string }>
	getPrimaryChatId: () => number | string | null
	getDefaultCli: () => string
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

	// /model command - switch AI model (with aliases)
	if (trimmed.startsWith('/model')) {
		const arg = trimmed.slice(6).trim().toLowerCase()
		if (!arg) {
			return { handled: true, response: 'Usage: /model <alias>\nAliases: opus, sonnet, haiku, codex\nFull IDs also supported (e.g., claude-opus-4-5-20251101)' }
		}
		// Model alias mappings (based on CLI docs)
		const modelAliases: Record<string, string> = {
			// Claude models
			opus: 'claude-opus-4-5-20251101',
			sonnet: 'claude-sonnet-4-5-20250929',
			haiku: 'claude-haiku-4-5-20251001',
			// OpenAI Codex models
			codex: 'gpt-5.2',
			'codex-max': 'gpt-5.1-codex-max',
			// Gemini
			gemini: 'gemini-3-pro-preview',
			'gemini-flash': 'gemini-3-flash-preview',
		}
		const modelId = modelAliases[arg] || arg
		// Store model preference (will be passed to CLI on next session)
		// Note: setChatSettings merges with existing settings, so this won't clobber streaming/verbose
		if (persistentStore) {
			await persistentStore.setChatSettings(chatId, { model: modelId })
		}
		return { handled: true, response: `Model set to: ${modelId}\nWill apply to next message (start /new session for fresh context).` }
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

	// /interrupt or /skip - stop current agent turn but keep queue and session
	if (trimmed === '/interrupt' || trimmed === '/skip') {
		const session = sessionStore.get(chatId)
		if (!session) {
			return { handled: true, response: 'No active task to interrupt.' }
		}
		// Terminate the current session but keep the queue
		session.terminate()
		sessionStore.delete(chatId)
		const queueLen = sessionStore.getQueueLength(chatId)
		const queueMsg = queueLen > 0 ? ` Processing next queued message (${queueLen} pending).` : ''
		// Signal async handling to flush queue using structured flag
		return { handled: true, response: `__INTERRUPT__:⏭️ Task interrupted.${queueMsg}`, async: true }
	}

	// /restart - gracefully restart the gateway (launchd will respawn)
	if (trimmed === '/restart') {
		console.log('[jsonl-bridge] Restart requested via /restart command')
		// Schedule exit after sending response (give time for message to be sent)
		setTimeout(() => {
			console.log('[jsonl-bridge] Exiting for restart...')
			process.exit(0)
		}, 500)
		return { handled: true, response: '🔄 Restarting gateway...' }
	}

	if (trimmed === '/status') {
		const session = sessionStore.get(chatId)
		const currentCli = sessionStore.getActiveCli(chatId) || session?.cli || defaultCli
		const resumeToken = sessionStore.getResumeToken(chatId, currentCli)
		const settings = persistentStore?.getChatSettings(chatId) ?? { streaming: false, verbose: false }
		if (!session && !resumeToken) {
			return { handled: true, response: `No active session. CLI: ${currentCli}\nStreaming: ${settings.streaming ? 'on' : 'off'}` }
		}
		const info = session?.getInfo()
		const lines = [
			`CLI: ${currentCli}`,
			`State: ${info?.state || 'ready'}`,
			`Streaming: ${settings.streaming ? 'on' : 'off'}`,
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

	// Hidden feature: /verbose - shows tool names and outputs (off by default)
	if (trimmed === '/verbose' || trimmed === '/verbose on' || trimmed === '/verbose off') {
		if (!persistentStore) {
			return { handled: true, response: 'Settings not available.' }
		}
		const current = persistentStore.getChatSettings(chatId)
		const newValue = trimmed === '/verbose off' ? false : trimmed === '/verbose on' ? true : !current.verbose
		await persistentStore.setChatSettings(chatId, { verbose: newValue })
		return { handled: true, response: `Verbose ${newValue ? 'enabled' : 'disabled'}. Tool ${newValue ? 'names and outputs will be shown' : 'details hidden'}.` }
	}

	if (trimmed.startsWith('/concepts')) {
		const term = trimmed.replace('/concepts', '').trim()
		if (!term) {
			return { handled: true, response: 'Usage: /concepts <term>' }
		}

		const manager = createConceptsIndex(workingDirectory)
		const index = await manager.loadIndex()
		if (!index) {
			return { handled: true, response: 'No concepts index found. Run "tg-concepts rebuild" on the server.' }
		}

		const config = await loadConceptConfig(manager.getConfigDir())
		const normalizedConfig = normalizeConceptConfig(config)
		const canonical = normalizeConcept(term, normalizedConfig)
		if (!canonical) {
			return { handled: true, response: `No concept found for "${term}".` }
		}

		const entry = index.concepts[canonical]
		if (!entry) {
			return { handled: true, response: `No concept found for "${canonical}".` }
		}

		const mentions = entry.mentions.slice(0, 20)
		const remaining = entry.mentions.length - mentions.length
		const lines = mentions.map(mention => `- ${mention.file} (${mention.count})`)
		if (remaining > 0) {
			lines.push(`...and ${remaining} more`)
		}
		return { handled: true, response: [`Files mentioning "${canonical}":`, ...lines].join('\n') }
	}

	if (trimmed.startsWith('/related')) {
		const term = trimmed.replace('/related', '').trim()
		if (!term) {
			return { handled: true, response: 'Usage: /related <term>' }
		}

		const manager = createConceptsIndex(workingDirectory)
		const index = await manager.loadIndex()
		if (!index) {
			return { handled: true, response: 'No concepts index found. Run "tg-concepts rebuild" on the server.' }
		}

		const config = await loadConceptConfig(manager.getConfigDir())
		const normalizedConfig = normalizeConceptConfig(config)
		const canonical = normalizeConcept(term, normalizedConfig)
		if (!canonical) {
			return { handled: true, response: `No concept found for "${term}".` }
		}

		const entry = index.concepts[canonical]
		if (!entry) {
			return { handled: true, response: `No concept found for "${canonical}".` }
		}

		const relatedEntries = Object.entries(entry.related).slice(0, 10)
		const relatedLines = relatedEntries.map(([related, score]) => `- ${related} (${score})`)
		const relatedFiles = getRelatedFilesForTerms(index, [canonical], 5)
		const fileLines = relatedFiles.map(file => `- ${file}`)
		const responseLines = [`Related concepts for "${canonical}":`]
		if (relatedLines.length > 0) {
			responseLines.push(...relatedLines)
		} else {
			responseLines.push('(none)')
		}
		if (fileLines.length > 0) {
			responseLines.push('', 'Related files:', ...fileLines)
		}
		return { handled: true, response: responseLines.join('\n') }
	}

	if (trimmed.startsWith('/file')) {
		const filePath = trimmed.replace('/file', '').trim()
		if (!filePath) {
			return { handled: true, response: 'Usage: /file <path>' }
		}

		const manager = createConceptsIndex(workingDirectory)
		const index = await manager.loadIndex()
		if (!index) {
			return { handled: true, response: 'No concepts index found. Run "tg-concepts rebuild" on the server.' }
		}

		const relative = getRelativePath(filePath, workingDirectory)
		const entry = index.files[relative]
		if (!entry) {
			return { handled: true, response: `No concepts found for "${relative}".` }
		}

		const lines = entry.concepts.map(concept => `- ${concept}`)
		return { handled: true, response: [`Concepts in ${relative}:`, ...lines].join('\n') }
	}

	if (trimmed.startsWith('/aliases')) {
		const args = trimmed.replace('/aliases', '').trim()
		const manager = createConceptsIndex(workingDirectory)
		const config = await loadConceptConfig(manager.getConfigDir())
		const normalizedConfig = normalizeConceptConfig(config)

		if (args === '' || args === 'list') {
			const entries = Object.entries(config.aliases ?? {}).sort((a, b) => a[0].localeCompare(b[0]))
			if (entries.length === 0) {
				return { handled: true, response: 'No aliases configured.' }
			}
			const lines = entries.map(([alias, canonical]) => `- ${alias} -> ${canonical}`)
			return { handled: true, response: ['Aliases:', ...lines].join('\n') }
		}

		const addMatch = args.match(/^add\s+(\S+)\s+(.+)$/)
		if (addMatch) {
			const normalizedAlias = normalizeConceptToken(addMatch[1])
			const normalizedCanonical = normalizeConceptToken(addMatch[2])
			if (!normalizedAlias || !normalizedCanonical) {
				return { handled: true, response: 'Alias and canonical terms must be non-empty.' }
			}
			const canonical = normalizeConcept(addMatch[2], normalizedConfig) ?? normalizedCanonical
			config.aliases = config.aliases ?? {}
			config.aliases[normalizedAlias] = canonical
			await saveConceptConfig(config, manager.getConfigDir())
			return { handled: true, response: `Added alias: ${normalizedAlias} -> ${canonical}` }
		}

		const removeMatch = args.match(/^remove\s+(\S+)$/)
		if (removeMatch) {
			const normalizedAlias = normalizeConceptToken(removeMatch[1])
			if (!normalizedAlias || !config.aliases || !config.aliases[normalizedAlias]) {
				return { handled: true, response: `Alias not found: ${removeMatch[1]}` }
			}
			delete config.aliases[normalizedAlias]
			await saveConceptConfig(config, manager.getConfigDir())
			return { handled: true, response: `Removed alias: ${normalizedAlias}` }
		}

	return { handled: true, response: 'Usage: /aliases list | /aliases add <alias> <canonical> | /aliases remove <alias>' }
	}

	// /spec command - create plan for approval
	if (trimmed.startsWith('/spec ')) {
		const task = trimmed.slice(6).trim()
		if (!task) {
			return { handled: true, response: 'Usage: /spec <task description>' }
		}
		// Signal that this is a spec command - actual planning handled in bridge
		return { handled: true, response: '__SPEC__', async: true }
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

const sendFileToGateway = async (
	baseUrl: string,
	authToken: string | undefined,
	chatId: number | string,
	filePath: string,
	caption?: string
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
			body: JSON.stringify({ chatId, documentPath: filePath, caption }),
		})
		if (!response.ok) {
			const body = await response.text().catch(() => '')
			void logToFile('error', 'bridge send file non-200', {
				status: response.status,
				chatId,
				filePath,
				body: body.slice(0, 1000),
			})
			return false
		}
		return true
	} catch (err) {
		console.error(`[jsonl-bridge] Failed to send file:`, err)
		const message = err instanceof Error ? err.message : 'unknown error'
		void logToFile('error', 'bridge send file failed', { error: message, chatId, filePath })
		return false
	}
}

/**
 * Extract [Sendfile: /path/to/file] patterns from text
 * Returns array of { filePath, caption? } and the remaining text
 */
const extractSendfileCommands = (text: string): { files: Array<{ path: string; caption?: string }>; remainingText: string } => {
	const pattern = /\[Sendfile:\s*([^\]]+)\](?:\s*\n*(?:Caption:\s*([^\n]+))?)?/gi
	const files: Array<{ path: string; caption?: string }> = []
	
	let match
	while ((match = pattern.exec(text)) !== null) {
		const filePath = match[1].trim()
		const caption = match[2]?.trim()
		files.push({ path: filePath, caption })
	}
	
	// Remove the sendfile commands from text
	const remainingText = text.replace(pattern, '').trim()
	
	return { files, remainingText }
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

type NativeSpecModeOptions = {
	chatId: number | string
	task: string
	cli: string
	manifests: Map<string, CLIManifest>
	workingDirectory: string
	gatewayUrl: string
	authToken?: string
	send: (chatId: number | string, text: string) => Promise<void>
	typing: (chatId: number | string) => Promise<void>
	sessionStore: SessionStore
}

/**
 * Run agent in native spec mode using the adapter's specMode.flag
 * The agent will create a plan and emit a spec_plan event when ExitSpecMode is called
 */
const runNativeSpecMode = async (opts: NativeSpecModeOptions): Promise<void> => {
	const { chatId, task, cli, manifests, workingDirectory, gatewayUrl, authToken, send, typing, sessionStore } = opts

	const manifest = manifests.get(cli)
	if (!manifest) {
		await send(chatId, `❌ CLI not found: ${cli}`)
		return
	}

	// Check if this CLI supports spec mode
	if (!manifest.specMode?.flag) {
		await send(chatId, `⚠️ CLI '${cli}' does not support native spec mode. Using fallback plan generation.`)
		// Could fall back to old createPlanForApproval here, but for now just return
		return
	}

	await send(chatId, '📋 Planning with native spec mode...')
	console.log(`[jsonl-bridge] Starting native spec mode for task: "${task.slice(0, 50)}..."`)

	// Set up spec mode state
	setSpecMode({
		chatId,
		active: true,
		originalTask: task,
		cli,
		createdAt: new Date().toISOString(),
	})

	// Start typing indicator
	let typingInterval: ReturnType<typeof setInterval> | null = null
	void typing(chatId)
	typingInterval = setInterval(() => void typing(chatId), 4000)

	const stopTypingLoop = () => {
		if (typingInterval) {
			clearInterval(typingInterval)
			typingInterval = null
		}
	}

	// Create session
	const session = new JsonlSession(chatId, manifest, workingDirectory)
	sessionStore.set(session)

	session.on('event', async (evt: BridgeEvent) => {
		switch (evt.type) {
			case 'started':
				console.log(`[jsonl-bridge] Spec mode session started: ${evt.sessionId}`)
				break

			case 'spec_plan': {
				// Agent exited spec mode with a plan
				console.log(`[jsonl-bridge] Received spec plan from agent`)
				stopTypingLoop()
				
				// Store the plan
				setPendingPlan(chatId, evt.plan)
				
				// Send plan with approval buttons
				const httpUrl = gatewayUrl.replace(/^ws/, 'http').replace('/events', '')
				const headers: Record<string, string> = { 'Content-Type': 'application/json' }
				if (authToken) {
					headers.Authorization = `Bearer ${authToken}`
				}

				const planMessage = `📋 **Implementation Plan**\n\n${evt.plan}\n\n---\nReply with "proceed", "yes", or similar to execute. Reply with "cancel" to abort. Or send feedback to refine the plan.`

				try {
					await fetch(`${httpUrl}/send`, {
						method: 'POST',
						headers,
						body: JSON.stringify({
							chatId,
							text: planMessage,
							inlineButtons: [
								[
									{ text: '✅ Approve', callbackData: 'spec:approve' },
									{ text: '❌ Cancel', callbackData: 'spec:cancel' },
								],
							],
						}),
					})
				} catch (err) {
					console.error('[jsonl-bridge] Failed to send spec plan with buttons:', err)
					await send(chatId, planMessage)
				}
				break
			}

			case 'text':
				// In spec mode, text output might be intermediate thinking
				// We could optionally show this to the user
				break

			case 'completed': {
				stopTypingLoop()
				console.log(`[jsonl-bridge] Spec mode session completed: ${evt.sessionId}`)
				
				// If we didn't get a spec_plan event, the agent might have output the plan as text
				const specState = getSpecMode(chatId)
				if (specState && !specState.pendingPlan) {
					if (evt.answer) {
						// Treat the final answer as the plan
						setPendingPlan(chatId, evt.answer)
						
						const planMessage = `📋 **Implementation Plan**\n\n${evt.answer}\n\n---\nReply with "proceed", "yes", or similar to execute. Reply with "cancel" to abort. Or send feedback to refine the plan.`
						await send(chatId, planMessage)
					} else {
						clearSpecMode(chatId)
						await send(chatId, '⚠️ Spec mode ended without a plan. Try /spec again.')
					}
				}
				break
			}

			case 'error':
				stopTypingLoop()
				clearSpecMode(chatId)
				await send(chatId, `❌ Spec mode error: ${evt.message}`)
				break
		}
	})

	session.on('exit', (code) => {
		stopTypingLoop()
		console.log(`[jsonl-bridge] Spec mode session exited with code ${code}`)
		sessionStore.delete(chatId)
		const specState = getSpecMode(chatId)
		if (specState && !specState.pendingPlan) {
			clearSpecMode(chatId)
		}
	})

	// Run with spec mode enabled (no resume for fresh planning)
	session.run(task, undefined, { specMode: true })
}

type CreatePlanOptions = {
	chatId: number | string
	task: string
	cli: string
	manifests: Map<string, CLIManifest>
	workingDirectory: string
	gatewayUrl: string
	authToken?: string
	send: (chatId: number | string, text: string) => Promise<void>
	messageId?: number
	userId?: number | string
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const createPlanForApproval = async (opts: CreatePlanOptions): Promise<void> => {
	const { chatId, task, cli, manifests, workingDirectory, gatewayUrl, authToken, send, messageId, userId } = opts

	const manifest = manifests.get(cli)
	if (!manifest) {
		await send(chatId, `❌ CLI not found: ${cli}`)
		return
	}

	await send(chatId, '📋 Creating plan...')
	console.log(`[jsonl-bridge] Creating plan for task: "${task.slice(0, 50)}..."`)

	// Create a session to generate the plan
	const session = new JsonlSession(`plan-${chatId}-${Date.now()}`, manifest, workingDirectory)

	let planText = ''
	const planPrompt = `Create a detailed implementation plan for the following task. Format your response as a structured plan with:

TITLE: <brief title>

STEPS:
1. <step description> [Files: file1.ts, file2.ts]
2. <step description> [Files: file3.ts]
...

RISKS:
- <potential risk or consideration>

Task: ${task}

Provide ONLY the plan in the format above, no additional commentary.`

	session.on('event', (evt: BridgeEvent) => {
		switch (evt.type) {
			case 'text':
				if (evt.text) {
					planText = evt.text
				}
				break

			case 'completed': {
				console.log(`[jsonl-bridge] Plan generation completed`)

				// Parse the plan from the response
				const plan = parsePlanFromText(planText || evt.answer || '')

				if (!plan || plan.steps.length === 0) {
					void send(chatId, '❌ Failed to generate plan. Please try again.')
					return
				}

				// Store the pending plan (createdAt as ISO string for serialization)
				storePendingPlan({
					chatId,
					plan,
					originalPrompt: task,
					cli,
					messageId,
					userId,
					createdAt: new Date().toISOString(),
				})

				// Send plan with inline buttons
				void sendPlanWithButtons(chatId, plan, gatewayUrl, authToken, send)
				break
			}

			case 'error':
				console.log(`[jsonl-bridge] Plan generation error: ${evt.message}`)
				void send(chatId, `❌ Plan generation failed: ${evt.message}`)
				break
		}
	})

	session.on('exit', (code) => {
		console.log(`[jsonl-bridge] Plan session exited with code ${code}`)
	})

	session.run(planPrompt)
}

const parsePlanFromText = (text: string): Plan | null => {
	try {
		const lines = text.split('\n')
		let title = 'Implementation Plan'
		const steps: Array<{ id: number; description: string; files?: string[] }> = []
		const risks: string[] = []

		let section: 'none' | 'steps' | 'risks' = 'none'

		for (const line of lines) {
			const trimmed = line.trim()

			if (trimmed.startsWith('TITLE:')) {
				title = trimmed.slice(6).trim()
			} else if (trimmed === 'STEPS:') {
				section = 'steps'
			} else if (trimmed === 'RISKS:') {
				section = 'risks'
			} else if (section === 'steps' && /^\d+\./.test(trimmed)) {
				const match = trimmed.match(/^(\d+)\.\s*(.+)$/)
				if (match) {
					const id = Number.parseInt(match[1], 10)
					let description = match[2]
					let files: string[] | undefined

					// Extract files if present
					const filesMatch = description.match(/\[Files?:\s*([^\]]+)\]/)
					if (filesMatch) {
						files = filesMatch[1].split(',').map((f) => f.trim())
						description = description.replace(/\[Files?:\s*[^\]]+\]/, '').trim()
					}

					steps.push({ id, description, files })
				}
			} else if (section === 'risks' && trimmed.startsWith('-')) {
				risks.push(trimmed.slice(1).trim())
			}
		}

		if (steps.length === 0) {
			return null
		}

		return {
			title,
			steps,
			risks: risks.length > 0 ? risks : undefined,
		}
	} catch {
		return null
	}
}

const sendPlanWithButtons = async (
	chatId: number | string,
	plan: Plan,
	gatewayUrl: string,
	authToken: string | undefined,
	send: (chatId: number | string, text: string) => Promise<void>
) => {
	const planText = formatPlanForDisplay(plan)

	// Send via HTTP endpoint with inline buttons using configured gateway URL
	const httpUrl = gatewayUrl.replace(/^ws/, 'http').replace('/events', '')
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (authToken) {
		headers.Authorization = `Bearer ${authToken}`
	}

	try {
		await fetch(`${httpUrl}/send`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				chatId,
				text: planText,
				inlineButtons: [
					[
						{ text: '✅ Approve', callbackData: 'plan:approve' },
						{ text: '❌ Cancel', callbackData: 'plan:cancel' },
					],
				],
			}),
		})
	} catch (err) {
		console.error('[jsonl-bridge] Failed to send plan with buttons:', err)
		await send(chatId, planText + '\n\n(Failed to add buttons)')
	}
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
	// Send spawn confirmation immediately - subagent runs in background
	await send(chatId, `🚀 Spawned: ${displayName}\n   CLI: ${cliName}\n   Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`)

	console.log(`[jsonl-bridge] Spawning subagent ${record.runId} with ${cliName}: "${task.slice(0, 50)}..."`)

	// Run subagent in background on the Subagent lane (fire-and-forget)
	void enqueueCommandInLane(CommandLane.Subagent, async () => {
		// Create a new session for the subagent (marked as subagent, no resume - fresh context)
		const session = new JsonlSession(`subagent-${record.runId}`, manifest, workingDirectory, { isSubagent: true })

		let lastText = ''

		return new Promise<void>((resolve) => {
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
				resolve()
			})

			// Run the subagent (no resume token - fresh session)
			session.run(task)
		})
	})
}

export const startBridge = async (config: BridgeConfig): Promise<BridgeHandle> => {
	// Initialize lane-based command queue with default concurrency
	initDefaultLanes()
	console.log('[jsonl-bridge] Initialized command lanes (Main: 1, Subagent: 4, Cron: 1)')

	const manifests = await loadAllManifests(config.adaptersDir)
	if (manifests.size === 0) {
		console.warn('[jsonl-bridge] No CLI adapters found in', config.adaptersDir)
	}

	const sessionStore = createSessionStore()
	const persistentStore = await createPersistentSessionStore()
	const cronService = new CronService()
	await cronService.start()
	const conceptsIndex = createConceptsIndex(config.workingDirectory)
	const repoNames = await getRepoNames(config.workingDirectory)
	
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

	const buildRelatedContext = async (text: string): Promise<string | null> => {
		try {
			const index = await conceptsIndex.loadIndex()
			if (!index) return null

			const conceptConfig = await loadConceptConfig(conceptsIndex.getConfigDir())
			const terms = extractConceptsFromText(text, conceptConfig, repoNames)
			if (terms.length === 0) return null

			const relatedFiles = getRelatedFilesForTerms(index, terms, 5)
			if (relatedFiles.length === 0) return null

			return `Related files:\n${relatedFiles.map(file => `- ${file}`).join('\n')}`
		} catch (err) {
			const message = err instanceof Error ? err.message : 'unknown error'
			console.error('[jsonl-bridge] Failed to build related context:', message)
			return null
		}
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

	// Track the primary chat for cron job delivery and MCP spawn
	// Initialize from config if available so MCP can spawn before any Telegram message
	let primaryChatId: number | string | null = config.allowedChatIds?.[0] ?? null
	if (primaryChatId) {
		console.log(`[jsonl-bridge] Primary chat initialized from config: ${primaryChatId}`)
	}

	const processMessage = async (chatId: number | string, prompt: string) => {
		const t0 = Date.now()
		const originalPrompt = prompt

		// Use active CLI for this chat, or default (check persistent store first)
		const cliName = persistentStore.getActiveCli(chatId) || sessionStore.getActiveCli(chatId) || config.defaultCli
		
		// Inject any pending subagent results into the prompt
		const pendingResults = formatPendingResultsForInjection(chatId)
		if (pendingResults) {
			prompt = `${pendingResults}\n\n${prompt}`
			console.log(`[jsonl-bridge] Injected subagent results into prompt`)
		}

		const relatedContext = await buildRelatedContext(originalPrompt)
		if (relatedContext) {
			prompt = `${prompt}\n\n${relatedContext}`
		}

		// Log user message
		void persistentStore.logMessage(chatId, 'user', originalPrompt, undefined, cliName)
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
		let currentSessionId: string | undefined
		const taskRunByToolId = new Map<string, string>()
		let streamBuffer = ''
		let streamTimer: ReturnType<typeof setTimeout> | null = null
		const streamedTexts = new Set<string>()
		const STREAM_MIN_CHARS = 800
		const STREAM_IDLE_MS = 1500

		// Track files to send at completion (during streaming we just note them)
		const pendingFiles: Array<{ path: string; caption?: string }> = []

		const flushStreamBuffer = async (force = false) => {
			if (streamTimer) {
				clearTimeout(streamTimer)
				streamTimer = null
			}
			if (!streamBuffer || (!force && streamBuffer.length < STREAM_MIN_CHARS)) return
			
			// Extract any [Sendfile:] commands from streaming text
			const { files, remainingText } = extractSendfileCommands(streamBuffer)
			
			// Queue files to send after completion (don't send mid-stream)
			for (const file of files) {
				if (!pendingFiles.some(f => f.path === file.path)) {
					pendingFiles.push(file)
				}
			}
			
			const toSend = remainingText.trim()
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
					currentSessionId = evt.sessionId
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
					// Map Droid Task tool calls to subagent records
					if (evt.name === 'Task') {
						const input = evt.input ?? {}
						const description = typeof input.description === 'string' ? input.description : undefined
						const prompt = typeof input.prompt === 'string'
							? input.prompt
							: typeof description === 'string'
								? description
								: 'Task'
						if (!taskRunByToolId.has(evt.toolId)) {
							const record = subagentRegistry.spawn({
								chatId,
								task: prompt,
								cli: cliName,
								label: description,
								parentSessionId: currentSessionId,
							})
							subagentRegistry.markRunning(record.runId, evt.toolId)
							taskRunByToolId.set(evt.toolId, record.runId)
							void saveSubagentRegistry()
						}
					}
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
					if (taskRunByToolId.has(evt.toolId)) {
						const runId = taskRunByToolId.get(evt.toolId) as string
						taskRunByToolId.delete(evt.toolId)
						if (evt.isError) {
							subagentRegistry.markError(runId, evt.preview || 'Task failed')
						} else {
							subagentRegistry.markCompleted(runId, evt.preview || '(no output)')
						}
						void send(chatId, formatSubagentAnnouncement(subagentRegistry.get(runId)!))
						subagentRegistry.prune(chatId)
						void saveSubagentRegistry()
					}
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
					
					// Send any files that were queued during streaming
					for (const file of pendingFiles) {
						console.log(`[jsonl-bridge] Sending queued file attachment: ${file.path}`)
						const sent = await sendFileToGateway(config.gatewayUrl, config.authToken, chatId, file.path, file.caption)
						if (!sent) {
							await send(chatId, `❌ Failed to send file: ${file.path}`)
						}
					}
					
					if (evt.answer) {
						void persistentStore.logMessage(chatId, 'assistant', evt.answer, evt.sessionId, cliName)
						
						// Extract and send any file attachments from the response (for non-streaming case)
						const { files, remainingText } = extractSendfileCommands(evt.answer)
						for (const file of files) {
							// Skip if already sent from pendingFiles
							if (pendingFiles.some(f => f.path === file.path)) continue
							console.log(`[jsonl-bridge] Sending file attachment: ${file.path}`)
							const sent = await sendFileToGateway(config.gatewayUrl, config.authToken, chatId, file.path, file.caption)
							if (!sent) {
								await send(chatId, `❌ Failed to send file: ${file.path}`)
							}
						}
						
						// Send remaining text (if any, and not already streamed)
						const textToSend = files.length > 0 ? remainingText : evt.answer
						if (textToSend) {
							// If streaming was on, check if we already sent this content
							if (getSettings().streaming && streamedTexts.has(textToSend.trim())) {
								// Already sent via streaming
							} else {
								const chunks = splitMessage(textToSend)
								for (const chunk of chunks) {
									if (!streamedTexts.has(chunk.trim())) {
										await send(chatId, chunk)
									}
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
		await processMessage(chatId, next.text)
	}

	const handleMessage = async (message: IncomingMessage) => {
		const { chatId, text, attachments, forward } = message
		if (!text && !attachments?.length) return

		// Build prompt with image paths if present
		let prompt = text || ''
		
		// Handle forwarded messages - prepend context about the original sender
		if (forward) {
			let forwardContext = '[Forwarded message'
			if (forward.fromUser) {
				const name = [forward.fromUser.firstName, forward.fromUser.lastName].filter(Boolean).join(' ')
				forwardContext += ` from ${name || 'unknown user'}`
				if (forward.fromUser.username) {
					forwardContext += ` (@${forward.fromUser.username})`
				}
			} else if (forward.fromChat) {
				forwardContext += ` from ${forward.fromChat.title || 'unknown chat'}`
				if (forward.fromChat.type) {
					forwardContext += ` (${forward.fromChat.type})`
				}
			}
			forwardContext += ']'
			prompt = `${forwardContext}\n${prompt}`
		}
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

		// Check if we're in spec mode and handle natural language intents
		if (isInSpecMode(chatId)) {
			const specState = getSpecMode(chatId)
			if (specState?.pendingPlan) {
				const intent = detectIntent(prompt)
				console.log(`[jsonl-bridge] Spec mode intent detected: ${intent}`)
				
				if (intent === 'approve') {
					// User approved the plan via natural language
					const plan = specState.pendingPlan
					const originalTask = specState.originalTask
					clearSpecMode(chatId)
					await send(chatId, '✅ Plan approved! Executing...')
					
					const executionPrompt = `Execute this approved plan:\n\n${plan}\n\nOriginal task: ${originalTask}\n\nProceed with implementation step by step.`
					await processMessage(chatId, executionPrompt)
					return
				} else if (intent === 'cancel') {
					// User cancelled the plan via natural language
					clearSpecMode(chatId)
					await send(chatId, '❌ Spec cancelled.')
					return
				}
				// intent === 'refine': pass the message through to refine the plan
				// For now, just clear spec mode and process normally
				// In the future, could resume with the feedback
				console.log(`[jsonl-bridge] Treating message as refinement feedback, clearing spec mode`)
				clearSpecMode(chatId)
			}
		}

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
			// Handle /spec command - use native spec mode
			if ('async' in cmdResult && cmdResult.response === '__SPEC__') {
				const task = prompt.slice(6).trim()
				const cliName = persistentStore.getActiveCli(chatId) || sessionStore.getActiveCli(chatId) || config.defaultCli
				void runNativeSpecMode({
					chatId,
					task,
					cli: cliName,
					manifests,
					workingDirectory: config.workingDirectory,
					gatewayUrl: config.gatewayUrl,
					authToken: config.authToken,
					send,
					typing,
					sessionStore,
				})
				return
			}

			if ('async' in cmdResult && cmdResult.response === '__SPAWN__') {
				const spawnCmd = parseSpawnCommand(prompt)
				if (spawnCmd) {
					// Inherit parent's CLI unless explicitly overridden
					const activeCli = persistentStore.getActiveCli(chatId) || sessionStore.getActiveCli(chatId) || config.defaultCli
					void spawnSubagent({
						chatId,
						task: spawnCmd.task,
						label: spawnCmd.label,
						cli: spawnCmd.cli || activeCli,
						manifests,
						defaultCli: config.defaultCli,
						workingDirectory: config.workingDirectory,
						send,
					})
					return
				}
			}
			
			// Handle /interrupt or /skip - send response then flush queue
			if ('async' in cmdResult && cmdResult.response.startsWith('__INTERRUPT__:')) {
				const userMessage = cmdResult.response.slice('__INTERRUPT__:'.length)
				console.log(`[jsonl-bridge] Task interrupted: ${text}`)
				await send(chatId, userMessage)
				// Flush the queue to process next message
				void flushQueue(chatId)
				return
			}
			
			console.log(`[jsonl-bridge] Command handled: ${text}`)
			await send(chatId, cmdResult.response)
			return
		}

		// Check for natural language spawn requests (e.g., "spawn a subagent to...")
		const naturalSpawn = parseNaturalSpawnRequest(prompt)
		if (naturalSpawn) {
			console.log(`[jsonl-bridge] Natural language spawn detected: "${naturalSpawn.task.slice(0, 50)}..."`)
			const activeCli = persistentStore.getActiveCli(chatId) || sessionStore.getActiveCli(chatId) || config.defaultCli
			void spawnSubagent({
				chatId,
				task: naturalSpawn.task,
				label: naturalSpawn.label,
				cli: naturalSpawn.cli || activeCli,
				manifests,
				defaultCli: config.defaultCli,
				workingDirectory: config.workingDirectory,
				send,
			})
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

		await processMessage(chatId, prompt)
	}

	const handleCallbackQuery = async (query: CallbackQuery) => {
		const { chatId, data, messageId, userId } = query

		if (data === 'plan:approve') {
			// Pass messageId and userId for proper identification
			const pendingPlan = getPendingPlan(chatId, messageId, userId)
			if (!pendingPlan) {
				await send(chatId, '❌ No pending plan found.')
				return
			}

			removePendingPlan(chatId, messageId, userId)
			await send(chatId, '✅ Plan approved! Executing...')

			// Execute the plan by running the original prompt with plan context
			const planContext = `You are executing an approved plan. Here is the plan:\n\n${formatPlanForDisplay(pendingPlan.plan)}\n\nOriginal task: ${pendingPlan.originalPrompt}\n\nPlease execute this plan step by step.`

			void handleMessage({
				id: `plan-exec-${Date.now()}`,
				chatId,
				text: planContext,
				userId: query.userId,
				messageId: query.messageId,
				timestamp: new Date().toISOString(),
				raw: { planExecution: true },
			})
		} else if (data === 'plan:cancel') {
			const pendingPlan = getPendingPlan(chatId, messageId, userId)
			if (pendingPlan) {
				removePendingPlan(chatId, messageId, userId)
				await send(chatId, '❌ Plan cancelled.')
			}
		} else if (data === 'spec:approve') {
			// Handle native spec mode approval
			const specState = getSpecMode(chatId)
			if (!specState || !specState.pendingPlan) {
				await send(chatId, '❌ No pending spec plan found.')
				return
			}

			const plan = specState.pendingPlan
			const originalTask = specState.originalTask
			clearSpecMode(chatId)
			await send(chatId, '✅ Plan approved! Executing...')

			// Execute the approved plan
			const executionPrompt = `Execute this approved plan:\n\n${plan}\n\nOriginal task: ${originalTask}\n\nProceed with implementation step by step.`

			void handleMessage({
				id: `spec-exec-${Date.now()}`,
				chatId,
				text: executionPrompt,
				userId: query.userId,
				messageId: query.messageId,
				timestamp: new Date().toISOString(),
				raw: { specExecution: true },
			})
		} else if (data === 'spec:cancel') {
			// Handle native spec mode cancellation
			if (isInSpecMode(chatId)) {
				clearSpecMode(chatId)
				await send(chatId, '❌ Spec cancelled.')
			}
		}
	}

	ws.on('message', (data) => {
		try {
			const event = JSON.parse(data.toString()) as GatewayEvent
			if (event.type === 'message.received') {
				void handleMessage(event.payload)
			} else if (event.type === 'callback.query') {
				void handleCallbackQuery(event.payload)
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

	// MCP spawn function that returns a runId
	const spawnSubagentForMcp = async (opts: {
		chatId: number | string
		task: string
		label?: string
		cli?: string
	}): Promise<{ runId: string; status: string }> => {
		const cliName = opts.cli || config.defaultCli

		// Check concurrency limit
		if (!subagentRegistry.canSpawn(opts.chatId)) {
			throw new Error('Too many subagents running')
		}

		const manifest = manifests.get(cliName)
		if (!manifest) {
			throw new Error(`CLI not found: ${cliName}`)
		}

		// Register the run
		const record = subagentRegistry.spawn({
			chatId: opts.chatId,
			task: opts.task,
			cli: cliName,
			label: opts.label,
		})

		const displayName = opts.label || `Subagent #${record.runId.slice(0, 8)}`
		// Send spawn confirmation immediately
		await send(opts.chatId, `🚀 Spawned: ${displayName}\n   CLI: ${cliName}\n   Task: ${opts.task.slice(0, 100)}${opts.task.length > 100 ? '...' : ''}`)

		console.log(`[jsonl-bridge] MCP spawning subagent ${record.runId} with ${cliName}: "${opts.task.slice(0, 50)}..."`)

		// Run subagent in background on the Subagent lane (fire-and-forget)
		void enqueueCommandInLane(CommandLane.Subagent, async () => {
			const session = new JsonlSession(`subagent-${record.runId}`, manifest, config.workingDirectory, { isSubagent: true })

			let lastText = ''

			return new Promise<void>((resolve) => {
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
							void send(opts.chatId, formatSubagentAnnouncement(subagentRegistry.get(record.runId)!))
							subagentRegistry.prune(opts.chatId)
							void saveSubagentRegistry()
							break

						case 'error':
							console.log(`[jsonl-bridge] Subagent ${record.runId} error: ${evt.message}`)
							subagentRegistry.markError(record.runId, evt.message)
							void send(opts.chatId, formatSubagentAnnouncement(subagentRegistry.get(record.runId)!))
							void saveSubagentRegistry()
							break
					}
				})

				session.on('exit', (code) => {
					console.log(`[jsonl-bridge] Subagent ${record.runId} exited with code ${code}`)
					const current = subagentRegistry.get(record.runId)
					if (current && current.status === 'running') {
						subagentRegistry.markError(record.runId, `Process exited with code ${code}`)
						void send(opts.chatId, formatSubagentAnnouncement(subagentRegistry.get(record.runId)!))
					}
					resolve()
				})

				session.run(opts.task)
			})
		})

		return { runId: record.runId, status: 'accepted' }
	}

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
		spawnSubagentForMcp,
		getPrimaryChatId: () => primaryChatId,
		getDefaultCli: () => config.defaultCli,
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
