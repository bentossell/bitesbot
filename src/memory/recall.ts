import { basename } from 'node:path'
import { createLinksIndex } from '../workspace/links-index.js'
import type { MemoryConfig } from './types.js'
import type { QmdSearchResult } from './qmd-client.js'
import { queryQmd } from './qmd-client.js'

export type RecallEntry = {
	path: string
	score: number
	title?: string
	startLine?: number
	endLine?: number
	snippet?: string
	related?: string[]
}

type SnippetInfo = {
	startLine?: number
	endLine?: number
	body: string
}

const SNIPPET_HEADER = /^@@\s+-(\d+),(\d+)\s+@@/

export const parseSnippet = (snippet: string): SnippetInfo => {
	if (!snippet) return { body: '' }
	const lines = snippet.split('\n')
	const header = lines[0] ?? ''
	const match = header.match(SNIPPET_HEADER)
	if (!match) {
		return { body: snippet }
	}
	const startLine = Number.parseInt(match[1], 10)
	const count = Number.parseInt(match[2], 10)
	const endLine = Number.isNaN(startLine) || Number.isNaN(count) ? undefined : startLine + count - 1
	const body = lines.slice(1).join('\n')
	return { startLine, endLine, body }
}

export const buildRecallEntries = (
	results: QmdSearchResult[],
	options: { maxResults: number; minScore?: number }
): RecallEntry[] => {
	const minScore = options.minScore ?? 0
	const filtered = results
		.filter((entry) => entry.score >= minScore)
		.sort((a, b) => b.score - a.score)
		.slice(0, options.maxResults)
	return filtered.map((entry) => {
		const snippet = entry.snippet ?? entry.body ?? ''
		const parsed = parseSnippet(snippet)
		return {
			path: entry.file,
			score: entry.score,
			title: entry.title,
			startLine: parsed.startLine,
			endLine: parsed.endLine,
			snippet: parsed.body || snippet,
		}
	})
}

const formatRelatedLinks = (related?: string[]): string | null => {
	if (!related || related.length === 0) return null
	return `Related links: ${related.join(', ')}`
}

export const formatRecallBlock = (entries: RecallEntry[]): string => {
	const lines: string[] = []
	lines.push(`Memory recall (top ${entries.length}):`)
	for (const entry of entries) {
		const range =
			entry.startLine && entry.endLine
				? `:${entry.startLine}-${entry.endLine}`
				: ''
		const score = Number.isFinite(entry.score) ? ` (score ${entry.score.toFixed(2)})` : ''
		lines.push(`- ${entry.path}${range}${score}`)
		if (entry.snippet) {
			const snippetLines = entry.snippet.split('\n').map((line) => `  ${line}`)
			lines.push(...snippetLines)
		}
		const related = formatRelatedLinks(entry.related)
		if (related) {
			lines.push(`  ${related}`)
		}
	}
	return lines.join('\n')
}

const normalizeLookupKeys = (path: string): string[] => {
	const normalized = path.replace(/\\/g, '/')
	const base = basename(normalized)
	const baseNoExt = base.replace(/\.[^.]+$/, '')
	return [normalized, base, baseNoExt].filter(Boolean)
}

const loadRelatedLinks = async (
	config: MemoryConfig,
	entryPath: string
): Promise<string[] | undefined> => {
	if (!config.links.enabled) return undefined
	try {
		const manager = createLinksIndex(config.workspaceDir, config.links.configDir)
		const index = await manager.loadIndex()
		if (!index) return undefined
		const keys = normalizeLookupKeys(entryPath)
		let resolved: { linkedFrom: string[]; linksTo: string[] } | null = null
		for (const key of keys) {
			const entry = index[key]
			if (entry) {
				resolved = { linkedFrom: entry.linkedFrom ?? [], linksTo: entry.linksTo ?? [] }
				break
			}
		}
		if (!resolved) return undefined
		const backlinks = resolved.linkedFrom.slice(0, config.links.maxBacklinks)
		const forward = resolved.linksTo.slice(0, config.links.maxForwardLinks)
		const combined = [...backlinks, ...forward]
		return combined.length ? combined : undefined
	} catch {
		return undefined
	}
}

export const buildMemoryRecall = async (
	query: string,
	config: MemoryConfig,
	searcher: (query: string) => Promise<QmdSearchResult[]> = (q) =>
		queryQmd(q, {
			qmdPath: config.qmdPath,
			collection: config.qmdCollection,
			indexPath: config.qmdIndexPath,
			maxResults: config.maxResults,
			minScore: config.minScore,
		})
): Promise<string | null> => {
	if (!config.enabled) return null
	const trimmed = query.trim()
	if (!trimmed) return null
	const results = await searcher(trimmed)
	const entries = buildRecallEntries(results, {
		maxResults: config.maxResults,
		minScore: config.minScore,
	})
	if (entries.length === 0) return null
	for (const entry of entries) {
		entry.related = await loadRelatedLinks(config, entry.path)
	}
	return formatRecallBlock(entries)
}
