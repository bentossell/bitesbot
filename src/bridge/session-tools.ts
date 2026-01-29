import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

type SessionLogEntry = {
	timestamp: string
	chatId: string | number
	role: 'user' | 'assistant' | 'system'
	text: string
	sessionId?: string
	cli?: string
	isSubagent?: boolean
	subagentRunId?: string
	parentSessionId?: string
}

export type SessionsListCall = {
	tool: 'sessions_list'
	/** max dates to return (default 14) */
	maxDates?: number
}

export type SessionsHistoryCall = {
	tool: 'sessions_history'
	/** YYYY-MM-DD; defaults to today (UTC) */
	date?: string
	/** defaults to current chat */
	chatId?: string | number
	/** filter to a specific session id */
	sessionId?: string
	/** include subagent entries (default false) */
	includeSubagents?: boolean
	/** max entries to return (default 50) */
	limit?: number
}

export type SessionsSendCall = {
	tool: 'sessions_send'
	chatId: string | number
	text: string
}

export type SessionsSpawnCall = {
	tool: 'sessions_spawn'
	/** defaults to current chat */
	chatId?: string | number
	task: string
	label?: string
	cli?: string
}

export type SessionToolCall = SessionsListCall | SessionsHistoryCall | SessionsSendCall | SessionsSpawnCall

export type SessionsListResult = {
	dates: Array<{ date: string; entries: number; chats: Array<string | number> }>
}

export type SessionsHistoryResult = {
	date: string
	chatId: string | number
	entries: Array<Pick<SessionLogEntry, 'timestamp' | 'role' | 'text' | 'sessionId' | 'cli' | 'isSubagent' | 'subagentRunId' | 'parentSessionId'>>
}

export type SessionsSendResult = { ok: true }

export type SessionsSpawnResult = { ok: true; runId?: string }

export type SessionToolResult =
	| { tool: 'sessions_list'; result: SessionsListResult }
	| { tool: 'sessions_history'; result: SessionsHistoryResult }
	| { tool: 'sessions_send'; result: SessionsSendResult }
	| { tool: 'sessions_spawn'; result: SessionsSpawnResult }

export const parseSessionToolCall = (text: string): SessionToolCall | null => {
	const trimmed = text.trim()
	if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
	let parsed: Record<string, unknown>
	try {
		parsed = JSON.parse(trimmed) as Record<string, unknown>
	} catch {
		return null
	}
	const tool = typeof parsed.tool === 'string' ? parsed.tool : typeof parsed.name === 'string' ? parsed.name : ''
	if (tool === 'sessions_list') {
		const maxDates = typeof parsed.maxDates === 'number' ? parsed.maxDates : undefined
		return { tool: 'sessions_list', maxDates }
	}
	if (tool === 'sessions_history') {
		const date = typeof parsed.date === 'string' ? parsed.date.trim() : undefined
		const chatId =
			typeof parsed.chatId === 'number'
				? parsed.chatId
				: typeof parsed.chatId === 'string'
					? parsed.chatId.trim()
					: undefined
		const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : undefined
		const includeSubagents = typeof parsed.includeSubagents === 'boolean' ? parsed.includeSubagents : undefined
		const limit = typeof parsed.limit === 'number' ? parsed.limit : undefined
		return {
			tool: 'sessions_history',
			date: date || undefined,
			chatId: chatId === '' ? undefined : chatId,
			sessionId: sessionId || undefined,
			includeSubagents,
			limit,
		}
	}
	if (tool === 'sessions_send') {
		const chatId =
			typeof parsed.chatId === 'number'
				? parsed.chatId
				: typeof parsed.chatId === 'string'
					? parsed.chatId.trim()
					: ''
		const msg = typeof parsed.text === 'string' ? parsed.text : typeof parsed.message === 'string' ? parsed.message : ''
		const text = msg.trim()
		if (!chatId || !text) return null
		return { tool: 'sessions_send', chatId, text }
	}
	if (tool === 'sessions_spawn') {
		const chatId =
			typeof parsed.chatId === 'number'
				? parsed.chatId
				: typeof parsed.chatId === 'string'
					? parsed.chatId.trim()
					: undefined
		const task = typeof parsed.task === 'string' ? parsed.task.trim() : ''
		if (!task) return null
		const label = typeof parsed.label === 'string' ? parsed.label.trim() : undefined
		const cli = typeof parsed.cli === 'string' ? parsed.cli.trim().toLowerCase() : undefined
		return { tool: 'sessions_spawn', chatId: chatId === '' ? undefined : chatId, task, label: label || undefined, cli: cli || undefined }
	}
	return null
}

const utcDateString = (d: Date): string => d.toISOString().split('T')[0] as string

const readSessionLog = async (workspaceDir: string, date: string): Promise<SessionLogEntry[]> => {
	const logPath = join(workspaceDir, 'sessions', `${date}.jsonl`)
	try {
		const content = await readFile(logPath, 'utf-8')
		const lines = content.trim().split('\n').filter(Boolean)
		return lines.map((line) => JSON.parse(line) as SessionLogEntry)
	} catch {
		return []
	}
}

const listSessionDates = async (
	workspaceDir: string
): Promise<Array<{ date: string; path: string }>> => {
	const sessionsDir = join(workspaceDir, 'sessions')
	let files: string[] = []
	try {
		files = await readdir(sessionsDir)
	} catch {
		return []
	}
	return files
		.filter((f) => f.endsWith('.jsonl'))
		.map((f) => ({ date: f.replace(/\.jsonl$/i, ''), path: join(sessionsDir, f) }))
		.sort((a, b) => b.date.localeCompare(a.date))
}

export type RunSessionToolOptions = {
	workspaceDir: string
	currentChatId: string | number
	sendToChat: (chatId: string | number, text: string) => Promise<void>
	spawnSubagent?: (opts: { chatId: string | number; task: string; label?: string; cli?: string }) => Promise<{ runId?: string } | null>
}

export const runSessionTool = async (call: SessionToolCall, opts: RunSessionToolOptions): Promise<SessionToolResult> => {
	if (call.tool === 'sessions_list') {
		const maxDates = Math.max(1, Math.min(60, call.maxDates ?? 14))
		const dates = await listSessionDates(opts.workspaceDir)
		const selected = dates.slice(0, maxDates)
		const rows: SessionsListResult['dates'] = []
		for (const d of selected) {
			const entries = await readSessionLog(opts.workspaceDir, d.date)
			const chats = Array.from(new Set(entries.map((e) => e.chatId)))
			rows.push({ date: d.date, entries: entries.length, chats })
		}
		return { tool: 'sessions_list', result: { dates: rows } }
	}

	if (call.tool === 'sessions_history') {
		const date = (call.date && /^\d{4}-\d{2}-\d{2}$/.test(call.date) ? call.date : utcDateString(new Date()))
		const chatId = call.chatId ?? opts.currentChatId
		const includeSubagents = call.includeSubagents === true
		const limit = Math.max(1, Math.min(500, call.limit ?? 50))
		const entries = await readSessionLog(opts.workspaceDir, date)
		const filtered = entries
			.filter((e) => String(e.chatId) === String(chatId))
			.filter((e) => (includeSubagents ? true : e.isSubagent !== true))
			.filter((e) => (call.sessionId ? e.sessionId === call.sessionId : true))
			.slice(-limit)
			.map((e) => ({
				timestamp: e.timestamp,
				role: e.role,
				text: e.text,
				sessionId: e.sessionId,
				cli: e.cli,
				isSubagent: e.isSubagent,
				subagentRunId: e.subagentRunId,
				parentSessionId: e.parentSessionId,
			}))
		return { tool: 'sessions_history', result: { date, chatId, entries: filtered } }
	}

	if (call.tool === 'sessions_send') {
		await opts.sendToChat(call.chatId, call.text)
		return { tool: 'sessions_send', result: { ok: true } }
	}

	// sessions_spawn
	const targetChatId = call.chatId ?? opts.currentChatId
	if (!opts.spawnSubagent) {
		await opts.sendToChat(targetChatId, '❌ sessions_spawn not available')
		return { tool: 'sessions_spawn', result: { ok: true } }
	}
	const spawned = await opts.spawnSubagent({
		chatId: targetChatId,
		task: call.task,
		label: call.label,
		cli: call.cli,
	})
	return { tool: 'sessions_spawn', result: { ok: true, runId: spawned?.runId } }
}

export const formatSessionToolResultPrompt = (
	call: SessionToolCall,
	result: SessionToolResult,
	originalPrompt: string
): string => {
	const header = `Tool result (${call.tool}):`
	const payload = JSON.stringify(result, null, 2)
	return `${header}\n${payload}\n\nContinue answering the original request:\n${originalPrompt}`
}

export const buildSessionToolInstructions = (): string =>
	[
		'Session tools available:',
		'- Use these to inspect gateway session logs and communicate across chats/sessions.',
		'- When you need a session tool, your next reply MUST be exactly one JSON tool call (no extra text).',
		'Examples:',
		'{"tool":"sessions_list","maxDates":14}',
		'{"tool":"sessions_history","date":"2026-01-29","chatId":123,"limit":50,"includeSubagents":false}',
		'{"tool":"sessions_send","chatId":123,"text":"hello"}',
		'{"tool":"sessions_spawn","task":"Run tests","label":"CI","cli":"droid"}',
	].join('\n')
