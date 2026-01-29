import WebSocket from 'ws'
import type { GatewayEvent, IncomingMessage } from '../protocol/types.js'
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
import type { CronJob } from '../cron/types.js'
import { logToFile } from '../logging/file.js'
import {
	subagentRegistry,
	saveSubagentRegistry,
	loadSubagentRegistry,
	formatPendingResultsForInjection,
	type SubagentRunRecord,
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
	parseAssistantSpawnCommand,
	findSubagent,
} from './subagent-commands.js'
import { buildMemoryRecall } from '../memory/recall.js'
import type { MemoryConfig } from '../memory/types.js'
import {
	buildMemoryToolInstructions,
	formatMemoryToolResultPrompt,
	parseMemoryToolCall,
	runMemoryTool,
	type MemoryToolCall,
} from '../memory/tools.js'
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
	subagentFallbackCli?: string
	workingDirectory: string
	allowedChatIds?: number[]
	memory?: MemoryConfig
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
	// Pi (uses same model IDs as underlying providers)
	pi: 'claude-sonnet-4-5-20250929',
	'pi-opus': 'claude-opus-4-5-20251101',
	'pi-haiku': 'claude-haiku-4-5-20251001',
}

export const resolveModelAlias = (alias: string): string => modelAliases[alias] || alias

const parseSlashCommand = (text: string): { command: string; rest: string } | null => {
	const trimmed = text.trim()
	if (!trimmed.startsWith('/')) return null
	const match = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
	if (!match) return null
	const token = match[1] ?? ''
	if (!token) return null
	const command = token.split('@')[0]?.toLowerCase()
	if (!command) return null
	return { command, rest: match[2]?.trim() ?? '' }
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
			return { handled: true, response: 'Usage: /model <alias>\nAliases: opus, sonnet, haiku, codex, pi\nFull IDs also supported (e.g., claude-opus-4-5-20251101)' }
		}
		const modelId = resolveModelAlias(arg)
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
	const slashCommand = parseSlashCommand(trimmed)
	if (slashCommand?.command === 'restart') {
		console.log('[jsonl-bridge] Restart requested via /restart command')
		// Schedule exit after sending response (give time for message to be sent)
		setTimeout(() => {
			console.log('[jsonl-bridge] Exiting for restart...')
			process.kill(process.pid, 'SIGTERM')
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

const SUBAGENT_SPAWN_INSTRUCTIONS = [
	'Subagent delegation:',
	'If the user explicitly asks to use a subagent, respond with exactly one line:',
	'/spawn "task description"',
	'Do not include any other text before or after /spawn.',
].join('\n')

const isSpawnDirectiveCandidate = (text: string): boolean =>
	text.trimStart().startsWith('/spawn')

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
	explicitCli?: boolean
	manifests: Map<string, CLIManifest>
	defaultCli: string
	subagentFallbackCli?: string
	workingDirectory: string
	model?: string
	send: (chatId: number | string, text: string) => Promise<void>
	logMessage?: (
		chatId: number | string,
		role: 'user' | 'assistant' | 'system',
		text: string,
		sessionId?: string,
		cli?: string,
		meta?: { isSubagent?: boolean; subagentRunId?: string; parentSessionId?: string }
	) => Promise<void>
	parentSessionId?: string
}

type SpawnSubagentInternalOptions = SpawnSubagentOptions & {
	throwOnError?: boolean
}

const spawnSubagentInternal = async (opts: SpawnSubagentInternalOptions): Promise<SubagentRunRecord | null> => {
	const { chatId, task, label, manifests, defaultCli, workingDirectory, send } = opts
	const requestedCli = opts.cli || defaultCli
	let cliName = requestedCli
	let usedFallback = false

	if (!opts.explicitCli && requestedCli === 'droid' && opts.subagentFallbackCli) {
		if (manifests.has(opts.subagentFallbackCli)) {
			cliName = opts.subagentFallbackCli
			usedFallback = true
		} else {
			await send(chatId, `⚠️ Subagent fallback CLI not found: ${opts.subagentFallbackCli}. Using droid.`)
		}
	}

	// Check concurrency limit
	if (!subagentRegistry.canSpawn(chatId)) {
		const message = 'Too many subagents running'
		if (opts.throwOnError) throw new Error(message)
		await send(chatId, '⚠️ Too many subagents running. Stop some first with /subagents stop all')
		return null
	}

	const manifest = manifests.get(cliName)
	if (!manifest) {
		const message = `CLI not found: ${cliName}`
		if (opts.throwOnError) throw new Error(message)
		await send(chatId, `❌ ${message}`)
		return null
	}

	// Register the run
	const record = subagentRegistry.spawn({
		chatId,
		task,
		cli: cliName,
		label,
		parentSessionId: opts.parentSessionId,
	})

	if (opts.logMessage) {
		void opts.logMessage(chatId, 'user', task, undefined, cliName, {
			isSubagent: true,
			subagentRunId: record.runId,
			parentSessionId: opts.parentSessionId,
		})
	}

	const displayName = label || `Subagent #${record.runId.slice(0, 8)}`
	// Send spawn confirmation immediately - subagent runs in background
	const fallbackNote = usedFallback ? ` (fallback from ${requestedCli})` : ''
	await send(chatId, `🚀 Spawned: ${displayName}\n   CLI: ${cliName}${fallbackNote}\n   Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`)

	console.log(`[jsonl-bridge] Spawning subagent ${record.runId} with ${cliName}: "${task.slice(0, 50)}..."`)

	// Run subagent in background on the Subagent lane (fire-and-forget)
	void enqueueCommandInLane(CommandLane.Subagent, async () => {
		// Create a new session for the subagent (marked as subagent, no resume - fresh context)
		const session = new JsonlSession(`subagent-${record.runId}`, manifest, workingDirectory, { isSubagent: true })

		let lastText = ''
		let loggedFinal = false
		let startedAnnounced = false

		return new Promise<void>((resolve) => {
			session.on('event', (evt: BridgeEvent) => {
				switch (evt.type) {
					case 'started': {
						subagentRegistry.markRunning(record.runId, evt.sessionId)
						console.log(`[jsonl-bridge] Subagent ${record.runId} started: ${evt.sessionId}`)
						if (!startedAnnounced) {
							startedAnnounced = true
							const startedLabel = label || `Subagent #${record.runId.slice(0, 8)}`
							void send(chatId, `🔄 Started: ${startedLabel}`)
						}
						break
					}

					case 'text':
						if (evt.text) {
							lastText = evt.text
						}
						break

					case 'completed':
						console.log(`[jsonl-bridge] Subagent ${record.runId} completed`)
						subagentRegistry.markCompleted(record.runId, evt.answer || lastText)
						if (opts.logMessage) {
							loggedFinal = true
							void opts.logMessage(chatId, 'assistant', evt.answer || lastText, evt.sessionId, cliName, {
								isSubagent: true,
								subagentRunId: record.runId,
								parentSessionId: opts.parentSessionId,
							})
						}
						// Announce completion
						void send(chatId, formatSubagentAnnouncement(subagentRegistry.get(record.runId)!))
						// Prune old runs and persist
						subagentRegistry.prune(chatId)
						void saveSubagentRegistry()
						break

					case 'error':
						console.log(`[jsonl-bridge] Subagent ${record.runId} error: ${evt.message}`)
						subagentRegistry.markError(record.runId, evt.message)
						if (opts.logMessage && !loggedFinal) {
							loggedFinal = true
							void opts.logMessage(chatId, 'system', evt.message, record.childSessionId, cliName, {
								isSubagent: true,
								subagentRunId: record.runId,
								parentSessionId: opts.parentSessionId,
							})
						}
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
					if (opts.logMessage && !loggedFinal) {
						loggedFinal = true
						void opts.logMessage(chatId, 'system', `Process exited with code ${code}`, current.childSessionId, cliName, {
							isSubagent: true,
							subagentRunId: record.runId,
							parentSessionId: opts.parentSessionId,
						})
					}
				}
				resolve()
			})

			// Run the subagent (no resume token - fresh session)
			session.run(task, undefined, { model: opts.model })
		})
	})

	return record
}

const spawnSubagent = async (opts: SpawnSubagentOptions): Promise<void> => {
	await spawnSubagentInternal(opts)
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

	type MessageContext = {
		source?: 'user' | 'cron' | 'memory-tool'
		cronJobId?: string
		memoryToolDepth?: number
	}

	const processMessage = async (chatId: number | string, prompt: string, context?: MessageContext) => {
		const t0 = Date.now()
		const originalPrompt = prompt
		let cronMarked = false

		// Use active CLI for this chat, or default (check persistent store first)
		const cliName = persistentStore.getActiveCli(chatId) || sessionStore.getActiveCli(chatId) || config.defaultCli
		
		// Inject any pending subagent results into the prompt
		const pendingResults = formatPendingResultsForInjection(chatId)
		if (pendingResults) {
			prompt = `${pendingResults}\n\n${prompt}`
			console.log(`[jsonl-bridge] Injected subagent results into prompt`)
		}

		if (config.memory?.enabled) {
			try {
				const memoryRecall = await buildMemoryRecall(originalPrompt, config.memory)
				if (memoryRecall) {
					prompt = `${memoryRecall}\n\n${prompt}`
				}
				if (context?.source !== 'memory-tool') {
					const memoryTools = buildMemoryToolInstructions()
					prompt = `${memoryTools}\n\n${prompt}`
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : 'unknown error'
				console.error('[jsonl-bridge] Failed to build memory recall:', message)
			}
		}

		if (!context?.source) {
			prompt = `${SUBAGENT_SPAWN_INSTRUCTIONS}\n\n${prompt}`
		}

		const relatedContext = await buildRelatedContext(originalPrompt)
		if (relatedContext) {
			prompt = `${prompt}\n\n${relatedContext}`
		}

		// Log user message
		const logRole = context?.source === 'memory-tool' ? 'system' : 'user'
		void persistentStore.logMessage(chatId, logRole, originalPrompt, undefined, cliName)
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
		let lastStreamedText = ''
		let streamTimer: ReturnType<typeof setTimeout> | null = null
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
			if (isSpawnDirectiveCandidate(streamBuffer)) return

			const delta = streamBuffer.startsWith(lastStreamedText)
				? streamBuffer.slice(lastStreamedText.length)
				: streamBuffer
			if (!delta.trim()) return

			// Extract any [Sendfile:] commands from streaming delta
			const { files, remainingText } = extractSendfileCommands(delta)

			// Queue files to send after completion (don't send mid-stream)
			for (const file of files) {
				if (!pendingFiles.some(f => f.path === file.path)) {
					pendingFiles.push(file)
				}
			}

			const toSend = remainingText.trim()
			if (toSend) {
				await send(chatId, toSend)
			}

			lastStreamedText = streamBuffer
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
						if (!streamBuffer) {
							streamBuffer = evt.text
						} else if (evt.text.startsWith(streamBuffer)) {
							// Snapshot-style updates (full text so far)
							streamBuffer = evt.text
						} else if (streamBuffer.startsWith(evt.text)) {
							// Older snapshot, ignore
						} else {
							// Incremental chunk
							streamBuffer += evt.text
						}
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

					case 'completed': {
						stopTypingLoop()
						if (streamTimer) {
							clearTimeout(streamTimer)
							streamTimer = null
						}
						if (context?.cronJobId && !cronMarked) {
							const errorMessage = evt.isError ? (evt.answer || 'error') : undefined
							cronService.markComplete(context.cronJobId, errorMessage)
							cronMarked = true
						}
						const assistantSpawn = evt.answer ? parseAssistantSpawnCommand(evt.answer) : null
						if (!assistantSpawn && getSettings().streaming) {
							await flushStreamBuffer(true)
						}
						console.log(`[jsonl-bridge] Completed: ${evt.sessionId}`)
						sessionStore.setResumeToken(chatId, cliName, { engine: cliName, sessionId: evt.sessionId })
						void persistentStore.setResumeToken(chatId, cliName, { engine: cliName, sessionId: evt.sessionId })

						if (assistantSpawn) {
							const activeCli = persistentStore.getActiveCli(chatId) || sessionStore.getActiveCli(chatId) || cliName
							const settings = getSettings()
							void spawnSubagent({
								chatId,
								task: assistantSpawn.task,
								label: assistantSpawn.label,
								cli: assistantSpawn.cli || activeCli,
								explicitCli: Boolean(assistantSpawn.cli),
								manifests,
								defaultCli: config.defaultCli,
								subagentFallbackCli: config.subagentFallbackCli,
								workingDirectory: config.workingDirectory,
								model: settings.model,
								send,
								logMessage: persistentStore.logMessage,
								parentSessionId: currentSessionId,
							})
							break
						}

						// Send any files that were queued during streaming
						for (const file of pendingFiles) {
							console.log(`[jsonl-bridge] Sending queued file attachment: ${file.path}`)
							const sent = await sendFileToGateway(config.gatewayUrl, config.authToken, chatId, file.path, file.caption)
							if (!sent) {
								await send(chatId, `❌ Failed to send file: ${file.path}`)
							}
						}

						if (evt.answer) {
							const toolDepth = context?.memoryToolDepth ?? 0
							const shouldCheckTool =
								config.memory?.enabled === true &&
								!getSettings().streaming &&
								toolDepth < 2
							let toolCall: MemoryToolCall | null = null
							if (shouldCheckTool) {
								toolCall = parseMemoryToolCall(evt.answer)
							}
							if (toolCall) {
								try {
									const toolResult = await runMemoryTool(toolCall, config.memory as MemoryConfig)
									const toolPrompt = formatMemoryToolResultPrompt(toolCall, toolResult, originalPrompt)
									await processMessage(chatId, toolPrompt, {
										...context,
										source: 'memory-tool',
										memoryToolDepth: toolDepth + 1,
									})
									break
								} catch (err) {
									const message = err instanceof Error ? err.message : 'unknown error'
									console.error('[jsonl-bridge] Memory tool failed:', message)
								}
							}

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
							if (getSettings().streaming) {
								const trimmed = textToSend.trim()
								if (!trimmed) {
									// nothing to send
								} else if (lastStreamedText && trimmed.startsWith(lastStreamedText)) {
									const delta = trimmed.slice(lastStreamedText.length).trim()
									if (delta) {
										const chunks = splitMessage(delta)
										for (const chunk of chunks) {
											await send(chatId, chunk)
										}
									}
								} else if (!lastStreamedText || trimmed !== lastStreamedText) {
									const chunks = splitMessage(trimmed)
									for (const chunk of chunks) {
										await send(chatId, chunk)
									}
								}
							} else {
								const chunks = splitMessage(textToSend)
								for (const chunk of chunks) {
									await send(chatId, chunk)
								}
							}
						}
					}
					if (evt.cost) {
						await send(chatId, `💰 Cost: $${evt.cost.toFixed(4)}`)
					}
					break
				}

					case 'error':
						stopTypingLoop()
						if (streamTimer) {
							clearTimeout(streamTimer)
							streamTimer = null
						}
						if (context?.cronJobId && !cronMarked) {
							cronService.markComplete(context.cronJobId, evt.message)
							cronMarked = true
						}
						await send(chatId, `❌ ${evt.message}`)
						break
				}
			})

		session.on('exit', (code) => {
			stopTypingLoop()
			console.log(`[jsonl-bridge] Session exited with code ${code}`)
			if (context?.cronJobId && !cronMarked) {
				cronService.markComplete(context.cronJobId, `Process exited with code ${code}`)
				cronMarked = true
			}
			sessionStore.delete(chatId)
			// Flush queue after session ends
			void flushQueue(chatId)
		})

		// Run with resume token if we have one
		const settings = getSettings()
		session.run(prompt, resumeToken, { model: settings.model })
	}

	const flushQueue = async (chatId: number | string) => {
		const next = sessionStore.dequeue(chatId)
		if (!next) return
		console.log(`[jsonl-bridge] Flushing queued message for ${chatId}`)
		await processMessage(chatId, next.text, next.context)
	}

	const handleMessage = async (message: IncomingMessage) => {
		const { chatId, text, attachments, forward } = message
		if (!text && !attachments?.length) return
		const raw = typeof message.raw === 'object' && message.raw ? (message.raw as Record<string, unknown>) : undefined
		const cronJobId = raw?.cron === true && typeof raw.jobId === 'string' ? raw.jobId : undefined
		const context: MessageContext | undefined = cronJobId ? { source: 'cron', cronJobId } : undefined
		if (!context?.cronJobId) {
			void triggerHeartbeat()
		}

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
			const notes: string[] = []
			for (const attachment of attachments) {
				if (!attachment.localPath) continue
				switch (attachment.type) {
					case 'photo':
						notes.push(`[Image: ${attachment.localPath}]`)
						break
					case 'document':
						notes.push(`[File: ${attachment.localPath}]`)
						break
					case 'audio':
						notes.push(`[Audio: ${attachment.localPath}]`)
						break
					case 'voice':
						notes.push(`[Voice: ${attachment.localPath}]`)
						break
				}
			}
			if (notes.length) {
				const attachmentNote = notes.join(' ')
				prompt = prompt ? `${attachmentNote}\n\n${prompt}` : attachmentNote
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
					// Inherit parent's CLI unless explicitly overridden
					const activeCli = persistentStore.getActiveCli(chatId) || sessionStore.getActiveCli(chatId) || config.defaultCli
					const settings = persistentStore.getChatSettings(chatId)
					void spawnSubagent({
						chatId,
						task: spawnCmd.task,
						label: spawnCmd.label,
						cli: spawnCmd.cli || activeCli,
						explicitCli: Boolean(spawnCmd.cli),
						manifests,
						defaultCli: config.defaultCli,
						subagentFallbackCli: config.subagentFallbackCli,
						workingDirectory: config.workingDirectory,
						model: settings.model,
						send,
						logMessage: persistentStore.logMessage,
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
			const settings = persistentStore.getChatSettings(chatId)
			void spawnSubagent({
				chatId,
				task: naturalSpawn.task,
				label: naturalSpawn.label,
				cli: naturalSpawn.cli || activeCli,
				explicitCli: Boolean(naturalSpawn.cli),
				manifests,
				defaultCli: config.defaultCli,
				subagentFallbackCli: config.subagentFallbackCli,
				workingDirectory: config.workingDirectory,
				model: settings.model,
				send,
				logMessage: persistentStore.logMessage,
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
				context,
			})
			await send(chatId, `📥 Queued (${queueLen + 1} pending). Will process after current task.`)
			return
		}

		await processMessage(chatId, prompt, context)
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

	const runCronJobMain = async (job: CronJob): Promise<void> => {
		if (!primaryChatId) {
			console.log('[jsonl-bridge] Cron job due but no primary chat set')
			return
		}
		const targetChatId = primaryChatId
		console.log(`[jsonl-bridge] Cron job triggered: ${job.name}`)
		await send(targetChatId, `⏰ Cron: ${job.name}`)
		void handleMessage({
			id: `cron-${Date.now()}`,
			chatId: targetChatId,
			text: job.message,
			userId: 'cron',
			messageId: 0,
			timestamp: new Date().toISOString(),
			raw: { cron: true, jobId: job.id },
		})
	}

	const runCronJobIsolated = async (job: CronJob): Promise<void> => {
		if (!primaryChatId) {
			console.log('[jsonl-bridge] Cron isolated job due but no primary chat set')
			return
		}
		const targetChatId = primaryChatId

		const manifest = manifests.get(config.defaultCli)
		if (!manifest) {
			await cronService.markIsolatedComplete(job.id, undefined, `CLI '${config.defaultCli}' not found`)
			await send(targetChatId, `❌ Cron (isolated) failed: CLI '${config.defaultCli}' not found`)
			return
		}

		await send(targetChatId, `⏰ Cron (isolated): ${job.name}`)

		void enqueueCommandInLane(CommandLane.Cron, async () => {
			const session = new JsonlSession(`cron-${job.id}-${Date.now()}`, manifest, config.workingDirectory)
			let lastText = ''
			let completed = false
			const modelOverride = job.model ?? persistentStore.getChatSettings(targetChatId).model

			const finish = async (summary?: string, error?: string) => {
				if (completed) return
				completed = true
				await cronService.markIsolatedComplete(job.id, summary, error)
				if (error) {
					await send(targetChatId, `❌ Cron (isolated) failed: ${job.name}\n${error}`)
				} else if (summary) {
					await send(targetChatId, `✅ Cron (isolated) complete: ${job.name}\n\n${summary}`)
				} else {
					await send(targetChatId, `✅ Cron (isolated) complete: ${job.name}`)
				}
			}

			return new Promise<void>((resolve) => {
				session.on('event', (evt: BridgeEvent) => {
					switch (evt.type) {
						case 'text':
							if (evt.text) lastText = evt.text
							break
						case 'completed': {
							const summary = evt.answer || lastText
							void finish(summary, evt.isError ? summary || 'error' : undefined).then(resolve)
							break
						}
						case 'error':
							void finish(undefined, evt.message).then(resolve)
							break
					}
				})

				session.on('exit', (code) => {
					if (!completed) {
						void finish(undefined, `Process exited with code ${code}`).then(resolve)
					}
				})

				session.run(job.message, undefined, { model: modelOverride })
			})
		})
	}

	const triggerHeartbeat = async (): Promise<void> => {
		const pending = cronService.flushPendingHeartbeat()
		for (const job of pending) {
			await runCronJobMain(job)
		}
	}

	// Handle cron job triggers
	cronService.on('event', async (evt) => {
		if (evt.type === 'job:due') {
			await runCronJobMain(evt.job)
			return
		}
		if (evt.type === 'job:isolated') {
			await runCronJobIsolated(evt.job)
		}
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
