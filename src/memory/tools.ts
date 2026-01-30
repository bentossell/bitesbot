import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { MemoryConfig } from './types.js'
import { parseSnippet } from './recall.js'
import { parseQmdJson } from './qmd-client.js'

const execFileAsync = promisify(execFile)

export type MemorySearchCall = {
	tool: 'memory_search'
	query: string
	maxResults?: number
	minScore?: number
}

export type MemoryGetCall = {
	tool: 'memory_get'
	path: string
	from?: number
	lines?: number
}

export type MemoryToolCall = MemorySearchCall | MemoryGetCall

export type MemorySearchResult = {
	path: string
	score: number
	title?: string
	startLine?: number
	endLine?: number
	snippet?: string
}

export type MemoryGetResult = {
	path: string
	text: string
	from?: number
	lines?: number
}

export type MemoryToolResult =
	| { tool: 'memory_search'; results: MemorySearchResult[] }
	| { tool: 'memory_get'; result: MemoryGetResult }

export const parseMemoryToolCall = (text: string): MemoryToolCall | null => {
	const trimmed = text.trim()
	if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
	let parsed: Record<string, unknown>
	try {
		parsed = JSON.parse(trimmed) as Record<string, unknown>
	} catch {
		return null
	}
	const tool = typeof parsed.tool === 'string' ? parsed.tool : typeof parsed.name === 'string' ? parsed.name : ''
	if (tool === 'memory_search') {
		const query = typeof parsed.query === 'string' ? parsed.query.trim() : ''
		if (!query) return null
		const maxResults = typeof parsed.maxResults === 'number' ? parsed.maxResults : undefined
		const minScore = typeof parsed.minScore === 'number' ? parsed.minScore : undefined
		return { tool: 'memory_search', query, maxResults, minScore }
	}
	if (tool === 'memory_get') {
		const path = typeof parsed.path === 'string' ? parsed.path.trim() : ''
		if (!path) return null
		const from = typeof parsed.from === 'number' ? parsed.from : undefined
		const lines = typeof parsed.lines === 'number' ? parsed.lines : undefined
		return { tool: 'memory_get', path, from, lines }
	}
	return null
}

const buildEnv = async (config: MemoryConfig) => {
	const env = { ...process.env }
	if (config.qmdIndexPath) {
		env.INDEX_PATH = config.qmdIndexPath
		await mkdir(dirname(config.qmdIndexPath), { recursive: true })
	}
	return env
}

export const runMemorySearch = async (
	call: MemorySearchCall,
	config: MemoryConfig
): Promise<MemorySearchResult[]> => {
	const args: string[] = [
		'query',
		call.query,
		'--json',
		'-n',
		String(call.maxResults ?? config.maxResults),
	]
	const minScore = call.minScore ?? config.minScore
	if (minScore !== undefined) {
		args.push('--min-score', String(minScore))
	}
	if (config.qmdCollection) {
		args.push('-c', config.qmdCollection)
	}
	const env = await buildEnv(config)
	const { stdout } = await execFileAsync(config.qmdPath, args, {
		env,
		maxBuffer: 5 * 1024 * 1024,
	})
	const rows = parseQmdJson(stdout)
	return rows.map((row) => {
		const snippet = row.snippet ?? row.body ?? ''
		const parsed = parseSnippet(snippet)
		return {
			path: row.file,
			score: row.score,
			title: row.title,
			startLine: parsed.startLine,
			endLine: parsed.endLine,
			snippet: parsed.body || snippet,
		}
	})
}

export const runMemoryGet = async (
	call: MemoryGetCall,
	config: MemoryConfig
): Promise<MemoryGetResult> => {
	const args: string[] = ['get', call.path]
	if (typeof call.lines === 'number') {
		args.push('-l', String(call.lines))
	}
	if (typeof call.from === 'number') {
		args.push('--from', String(call.from))
	}
	const env = await buildEnv(config)
	const { stdout } = await execFileAsync(config.qmdPath, args, {
		env,
		maxBuffer: 5 * 1024 * 1024,
	})
	return {
		path: call.path,
		text: stdout.trimEnd(),
		from: call.from,
		lines: call.lines,
	}
}

export const runMemoryTool = async (
	call: MemoryToolCall,
	config: MemoryConfig
): Promise<MemoryToolResult> => {
	if (call.tool === 'memory_search') {
		const results = await runMemorySearch(call, config)
		return { tool: 'memory_search', results }
	}
	const result = await runMemoryGet(call, config)
	return { tool: 'memory_get', result }
}

export const formatMemoryToolResultPrompt = (
	call: MemoryToolCall,
	result: MemoryToolResult,
	originalPrompt: string
): string => {
	const header = `Tool result (${call.tool}):`
	const payload = JSON.stringify(result, null, 2)
	return `${header}\n${payload}\n\nContinue answering the original request:\n${originalPrompt}`
}

export const buildMemoryToolInstructions = (): string =>
	[
		'Memory tools available:',
		'Recall guidance:',
		'- Before answering about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md.',
		'- Use memory_get to pull only the needed lines from the best file.',
		'- If you are still unsure after searching, say you checked and explain uncertainty.',
		'Use ONE of the following as your entire reply when you need memory:',
		'{"tool":"memory_search","query":"<query>","maxResults":6,"minScore":0.35}',
		'{"tool":"memory_get","path":"memory/file.md","from":1,"lines":20}',
	].join('\n')

export const buildRecallEnforcementHint = (): string =>
	[
		'RECALL REQUIRED:',
		'This question requires checking durable memory. Your next reply MUST be exactly one memory tool JSON call:',
		'- Start with memory_search using a precise query.',
		'- If you find a relevant file, follow with memory_get on the best path and line range.',
		'No other text, no analysis, no answer until memory is checked.',
	].join('\n')
