import { subagentRegistry, type SubagentRunRecord } from './subagent-registry.js'

export type SpawnCommandParseResult = {
	task: string
	label?: string
	cli?: string
}

/**
 * Parse /spawn command
 * Formats:
 *   /spawn "task description"
 *   /spawn --label "Research" "task"
 *   /spawn --cli droid "task"
 *   /spawn --label "Research" --cli droid "task"
 */
export function parseSpawnCommand(text: string): SpawnCommandParseResult | null {
	const trimmed = text.trim()
	if (!trimmed.startsWith('/spawn')) return null
	
	const args = trimmed.slice(6).trim()
	if (!args) return null

	let label: string | undefined
	let cli: string | undefined
	let remaining = args

	// Parse --label "value"
	const labelMatch = remaining.match(/^--label\s+"([^"]+)"\s*/)
	if (labelMatch) {
		label = labelMatch[1]
		remaining = remaining.slice(labelMatch[0].length)
	}

	// Parse --cli value
	const cliMatch = remaining.match(/^--cli\s+(\S+)\s*/)
	if (cliMatch) {
		cli = cliMatch[1].toLowerCase()
		remaining = remaining.slice(cliMatch[0].length)
	}

	// Parse --label again (can be in any order)
	if (!label) {
		const labelMatch2 = remaining.match(/^--label\s+"([^"]+)"\s*/)
		if (labelMatch2) {
			label = labelMatch2[1]
			remaining = remaining.slice(labelMatch2[0].length)
		}
	}

	// Rest is the task - can be quoted or unquoted
	remaining = remaining.trim()
	let task: string

	if (remaining.startsWith('"')) {
		const endQuote = remaining.indexOf('"', 1)
		if (endQuote === -1) {
			task = remaining.slice(1) // unterminated quote, take rest
		} else {
			task = remaining.slice(1, endQuote)
		}
	} else {
		task = remaining
	}

	if (!task) return null

	return { task, label, cli }
}

/**
 * Format subagent list for display
 */
export function formatSubagentList(records: SubagentRunRecord[]): string {
	if (records.length === 0) {
		return 'No subagents.'
	}

	const lines: string[] = ['📋 Subagents:']
	
	for (const record of records) {
		const statusIcon = getStatusIcon(record.status)
		const duration = record.endedAt && record.startedAt 
			? formatDuration(record.endedAt - record.startedAt)
			: record.startedAt 
				? formatDuration(Date.now() - record.startedAt)
				: ''
		
		const labelPart = record.label ? `"${record.label}"` : ''
		const taskPreview = record.task.length > 40 
			? record.task.slice(0, 40) + '...' 
			: record.task
		
		const idShort = record.runId.slice(0, 8)
		
		lines.push(`${statusIcon} #${idShort} ${record.cli} ${labelPart} ${duration}`)
		lines.push(`   ${taskPreview}`)
	}

	return lines.join('\n')
}

/**
 * Format subagent announcement when completed
 */
export function formatSubagentAnnouncement(record: SubagentRunRecord): string {
	const statusIcon = record.status === 'completed' ? '✅' : record.status === 'error' ? '❌' : '🛑'
	const label = record.label || 'Subagent'
	const duration = record.endedAt && record.startedAt 
		? formatDuration(record.endedAt - record.startedAt)
		: ''

	const lines: string[] = [
		`${statusIcon} ${label} ${duration ? `(${duration})` : ''}`,
		'',
	]

	if (record.result) {
		// Truncate long results
		const result = record.result.length > 2000 
			? record.result.slice(0, 2000) + '\n...(truncated)'
			: record.result
		lines.push(result)
	} else if (record.error) {
		lines.push(`Error: ${record.error}`)
	} else {
		lines.push('(no output)')
	}

	return lines.join('\n')
}

function getStatusIcon(status: SubagentRunRecord['status']): string {
	switch (status) {
		case 'queued': return '⏳'
		case 'running': return '🔄'
		case 'completed': return '✅'
		case 'error': return '❌'
		case 'stopped': return '🛑'
		default: return '❓'
	}
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000)
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	const remainingSeconds = seconds % 60
	if (minutes < 60) return `${minutes}m${remainingSeconds}s`
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	return `${hours}h${remainingMinutes}m`
}

/**
 * Parse /subagents command
 */
export type SubagentsCommandAction = 
	| { action: 'list' }
	| { action: 'stop'; target: string }
	| { action: 'stop-all' }
	| { action: 'log'; target: string }

export function parseSubagentsCommand(text: string): SubagentsCommandAction | null {
	const trimmed = text.trim()
	if (!trimmed.startsWith('/subagents')) return null
	
	const args = trimmed.slice(10).trim()
	
	if (!args || args === 'list') {
		return { action: 'list' }
	}
	
	// /subagents stop all
	if (args === 'stop all') {
		return { action: 'stop-all' }
	}
	
	// /subagents stop <id>
	const stopMatch = args.match(/^stop\s+(\S+)$/i)
	if (stopMatch) {
		return { action: 'stop', target: stopMatch[1] }
	}
	
	// /subagents log <id>
	const logMatch = args.match(/^log\s+(\S+)$/i)
	if (logMatch) {
		return { action: 'log', target: logMatch[1] }
	}
	
	return null
}

/**
 * Find a subagent by partial ID or index
 */
export function findSubagent(chatId: number | string, target: string): SubagentRunRecord | undefined {
	const records = subagentRegistry.list(chatId)
	
	// Try exact match first
	const exact = records.find(r => r.runId === target)
	if (exact) return exact
	
	// Try partial ID match (starts with)
	const partial = records.find(r => r.runId.startsWith(target))
	if (partial) return partial
	
	// Try numeric index (1-based, from most recent)
	const index = parseInt(target, 10)
	if (!isNaN(index) && index > 0 && index <= records.length) {
		const sorted = [...records].sort((a, b) => b.createdAt - a.createdAt)
		return sorted[index - 1]
	}
	
	return undefined
}
