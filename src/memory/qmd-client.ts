import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type QmdSearchResult = {
	docid: string
	score: number
	file: string
	title: string
	context?: string
	snippet?: string
	body?: string
}

export type QmdQueryOptions = {
	qmdPath: string
	collection?: string
	indexPath?: string
	maxResults?: number
	minScore?: number
	command?: 'query' | 'search' | 'vsearch'
}

type QmdJsonRow = {
	docid?: string
	score?: number
	file?: string
	title?: string
	context?: string
	snippet?: string
	body?: string
}

export const buildQmdArgs = (query: string, options: QmdQueryOptions): string[] => {
	const args: string[] = []
	const command = options.command ?? 'query'
	args.push(command, query, '--json')
	if (options.maxResults) {
		args.push('-n', String(options.maxResults))
	}
	if (options.minScore !== undefined) {
		args.push('--min-score', String(options.minScore))
	}
	if (options.collection) {
		args.push('-c', options.collection)
	}
	return args
}

export const parseQmdJson = (output: string): QmdSearchResult[] => {
	if (!output.trim()) return []
	const parsed = JSON.parse(output) as QmdJsonRow[]
	if (!Array.isArray(parsed)) return []
	return parsed
		.map((row) => ({
			docid: row.docid ?? '',
			score: typeof row.score === 'number' ? row.score : 0,
			file: row.file ?? '',
			title: row.title ?? '',
			context: row.context,
			snippet: row.snippet,
			body: row.body,
		}))
		.filter((row) => row.file)
}

const runQmdCommand = async (query: string, options: QmdQueryOptions): Promise<QmdSearchResult[]> => {
	const args = buildQmdArgs(query, options)
	const env = { ...process.env }
	if (options.indexPath) {
		env.INDEX_PATH = options.indexPath
		await mkdir(dirname(options.indexPath), { recursive: true })
	}
	const { stdout } = await execFileAsync(options.qmdPath, args, {
		env,
		maxBuffer: 5 * 1024 * 1024,
	})
	return parseQmdJson(stdout)
}

export const queryQmd = async (query: string, options: QmdQueryOptions): Promise<QmdSearchResult[]> => {
	try {
		return await runQmdCommand(query, options)
	} catch {
		if (options.command && options.command !== 'query') return []
		try {
			return await runQmdCommand(query, { ...options, command: 'search' })
		} catch {
			return []
		}
	}
}
