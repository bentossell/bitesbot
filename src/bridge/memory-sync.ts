import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

type SessionLogEntry = {
	timestamp: string
	chatId: string | number
	role: 'user' | 'assistant' | 'system'
	text: string
	sessionId?: string
	cli?: string
}

/**
 * Read today's session log entries from the workspace
 */
export const readTodaySessionLog = async (workspaceDir: string): Promise<SessionLogEntry[]> => {
	const date = new Date().toISOString().split('T')[0]
	const logPath = join(workspaceDir, 'sessions', `${date}.jsonl`)
	
	try {
		const content = await readFile(logPath, 'utf-8')
		const lines = content.trim().split('\n').filter(Boolean)
		return lines.map(line => JSON.parse(line) as SessionLogEntry)
	} catch {
		return []
	}
}

/**
 * Read session log for a specific date
 */
export const readSessionLog = async (workspaceDir: string, date: string): Promise<SessionLogEntry[]> => {
	const logPath = join(workspaceDir, 'sessions', `${date}.jsonl`)
	
	try {
		const content = await readFile(logPath, 'utf-8')
		const lines = content.trim().split('\n').filter(Boolean)
		return lines.map(line => JSON.parse(line) as SessionLogEntry)
	} catch {
		return []
	}
}

/**
 * Format session entries as markdown summary
 */
const formatSessionSummary = (entries: SessionLogEntry[]): string => {
	if (entries.length === 0) return ''
	
	const sections: string[] = []
	let currentSection: SessionLogEntry[] = []
	let lastTimestamp = ''
	
	for (const entry of entries) {
		const entryTime = new Date(entry.timestamp)
		
		// Start new section if gap > 30 mins
		if (lastTimestamp) {
			const lastTime = new Date(lastTimestamp)
			const gapMs = entryTime.getTime() - lastTime.getTime()
			if (gapMs > 30 * 60 * 1000 && currentSection.length > 0) {
				sections.push(formatSection(currentSection))
				currentSection = []
			}
		}
		
		currentSection.push(entry)
		lastTimestamp = entry.timestamp
	}
	
	if (currentSection.length > 0) {
		sections.push(formatSection(currentSection))
	}
	
	return sections.join('\n\n---\n\n')
}

/**
 * Format a section of conversation
 */
const formatSection = (entries: SessionLogEntry[]): string => {
	if (entries.length === 0) return ''
	
	const firstTime = new Date(entries[0].timestamp)
	const timeStr = firstTime.toISOString().split('T')[1]?.split('.')[0] || ''
	const cli = entries[0].cli || 'unknown'
	
	const lines = [`## ${timeStr} UTC (${cli})`]
	
	// Summarize the conversation - just key points
	const userMessages = entries.filter(e => e.role === 'user')
	const assistantMessages = entries.filter(e => e.role === 'assistant')
	
	// Add user queries (truncated)
	for (const msg of userMessages.slice(0, 5)) {
		const preview = msg.text.length > 200 ? msg.text.slice(0, 200) + '...' : msg.text
		lines.push(`\n**User:** ${preview}`)
	}
	if (userMessages.length > 5) {
		lines.push(`\n... and ${userMessages.length - 5} more messages`)
	}
	
	// Add last assistant response (truncated)
	const lastAssistant = assistantMessages[assistantMessages.length - 1]
	if (lastAssistant) {
		const preview = lastAssistant.text.length > 500 
			? lastAssistant.text.slice(0, 500) + '...' 
			: lastAssistant.text
		lines.push(`\n**Assistant:** ${preview}`)
	}
	
	return lines.join('\n')
}

/**
 * Sync session log to memory file for a given date
 */
export const syncSessionToMemory = async (
	workspaceDir: string,
	date?: string
): Promise<{ written: boolean; path: string; entries: number }> => {
	const targetDate = date || new Date().toISOString().split('T')[0]
	const entries = await readSessionLog(workspaceDir, targetDate)
	
	if (entries.length === 0) {
		return { written: false, path: '', entries: 0 }
	}
	
	const memoryDir = join(workspaceDir, 'memory')
	await mkdir(memoryDir, { recursive: true })
	
	const memoryPath = join(memoryDir, `${targetDate}.md`)
	
	// Check if memory file already exists with content
	let existingContent = ''
	try {
		existingContent = await readFile(memoryPath, 'utf-8')
	} catch {
		// File doesn't exist
	}
	
	// Generate summary from session log
	const summary = formatSessionSummary(entries)
	
	if (!summary) {
		return { written: false, path: memoryPath, entries: entries.length }
	}
	
	// If existing content, append session summary
	const header = `# Session Log: ${targetDate}\n\n`
	const newContent = existingContent 
		? `${existingContent}\n\n---\n\n## Session Log (auto-synced)\n\n${summary}`
		: `${header}${summary}`
	
	await writeFile(memoryPath, newContent, 'utf-8')
	
	return { written: true, path: memoryPath, entries: entries.length }
}

/**
 * Get list of session log dates that don't have memory files
 */
export const findUnsyncedDates = async (workspaceDir: string): Promise<string[]> => {
	const sessionsDir = join(workspaceDir, 'sessions')
	const memoryDir = join(workspaceDir, 'memory')
	
	let sessionFiles: string[] = []
	let memoryFiles: string[] = []
	
	try {
		sessionFiles = await readdir(sessionsDir)
	} catch {
		return []
	}
	
	try {
		memoryFiles = await readdir(memoryDir)
	} catch {
		// Memory dir doesn't exist yet
	}
	
	const sessionDates = sessionFiles
		.filter(f => f.endsWith('.jsonl'))
		.map(f => f.replace('.jsonl', ''))
	
	const memoryDates = new Set(
		memoryFiles
			.filter(f => f.endsWith('.md'))
			.map(f => f.replace('.md', ''))
	)
	
	return sessionDates.filter(d => !memoryDates.has(d))
}
