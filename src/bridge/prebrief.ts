import { execSync } from 'node:child_process'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logError } from '../logging/file.js'

const GCCLI_PATH = join(homedir(), 'tools', 'gccli')
const PREBRIEFS_DIR = join(homedir(), 'bites', 'memory', 'prebriefs')
const BITES_DIR = join(homedir(), 'bites')

// Default email account for calendar queries
const DEFAULT_CALENDAR_EMAIL = 'ben.tossell@gmail.com'
const DEFAULT_CALENDAR_ID = 'primary'

export type CalendarEvent = {
	id: string
	summary: string
	description?: string
	start: string
	end: string
	location?: string
	attendees?: string[]
	organizer?: string
}

export type PrebriefResult = {
	success: boolean
	event?: CalendarEvent
	prebrief?: string
	filePath?: string
	error?: string
}

/**
 * Parse gccli event output into structured data
 */
const parseEventOutput = (output: string): CalendarEvent | null => {
	try {
		// gccli outputs JSON for single event
		const data = JSON.parse(output)
		return {
			id: data.id,
			summary: data.summary || 'Untitled',
			description: data.description,
			start: data.start?.dateTime || data.start?.date || '',
			end: data.end?.dateTime || data.end?.date || '',
			location: data.location,
			attendees: data.attendees?.map((a: { email?: string }) => a.email).filter(Boolean),
			organizer: data.organizer?.email,
		}
	} catch {
		return null
	}
}

const getEventsForDate = async (
	date: Date,
	email = DEFAULT_CALENDAR_EMAIL
): Promise<CalendarEvent[]> => {
	const fromDate = date.toISOString().split('T')[0]
	const nextDay = new Date(date)
	nextDay.setDate(nextDay.getDate() + 1)
	const toDate = nextDay.toISOString().split('T')[0]

	try {
		const output = execSync(
			`${GCCLI_PATH} ${email} events ${DEFAULT_CALENDAR_ID} --from ${fromDate}T00:00:00Z --to ${toDate}T23:59:59Z`,
			{ encoding: 'utf-8', timeout: 30000 }
		)

		const events = JSON.parse(output)
		return events.map((e: Record<string, unknown>) => ({
			id: e.id as string,
			summary: (e.summary as string) || 'Untitled',
			description: e.description as string | undefined,
			start:
				(e.start as { dateTime?: string; date?: string })?.dateTime ||
				(e.start as { dateTime?: string; date?: string })?.date ||
				'',
			end:
				(e.end as { dateTime?: string; date?: string })?.dateTime ||
				(e.end as { dateTime?: string; date?: string })?.date ||
				'',
			location: e.location as string | undefined,
			attendees: (e.attendees as Array<{ email?: string }>)
				?.map((a) => a.email)
				.filter(Boolean) as string[] | undefined,
			organizer: (e.organizer as { email?: string })?.email,
		}))
	} catch (err) {
		logError('[prebrief] Failed to get calendar events:', err)
		return []
	}
}

/**
 * Get today's events from calendar
 */
export const getTodayEvents = async (email = DEFAULT_CALENDAR_EMAIL): Promise<CalendarEvent[]> => {
	return getEventsForDate(new Date(), email)
}

/**
 * Get tomorrow's events from calendar
 */
export const getTomorrowEvents = async (email = DEFAULT_CALENDAR_EMAIL): Promise<CalendarEvent[]> => {
	const tomorrow = new Date()
	tomorrow.setDate(tomorrow.getDate() + 1)
	return getEventsForDate(tomorrow, email)
}

const isHighPriority = (event: CalendarEvent): boolean => {
	const keywords = ['ade', 'sumtyme', 'investor', 'lp', 'board', 'critical', 'important']
	const text = `${event.summary} ${event.description || ''}`.toLowerCase()
	return keywords.some((kw) => text.includes(kw))
}

const formatEventTime = (value: string): string => {
	if (!value) return ''
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return ''
	return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

const formatTomorrowLabel = (): string => {
	const tomorrow = new Date()
	tomorrow.setDate(tomorrow.getDate() + 1)
	return tomorrow.toLocaleDateString('en-GB', {
		weekday: 'short',
		day: '2-digit',
		month: 'short',
	})
}

export const runPrebriefWatch = async (): Promise<string> => {
	const events = await getTomorrowEvents()
	if (events.length === 0) {
		return 'No events scheduled for tomorrow.'
	}

	const highPriority = events.filter(isHighPriority)
	const lines: string[] = ['📋 Pre-briefs Generated', '', `**Tomorrow (${formatTomorrowLabel()})**:`]

	for (const event of events) {
		const time = formatEventTime(event.start)
		const label = time ? `${event.summary} ${time}` : event.summary
		if (!isHighPriority(event)) {
			lines.push(`- ⏭️ ${label} — skipped (routine)`)
			continue
		}
		const prebrief = await generatePrebrief(event)
		const filePath = await savePrebriefFile(event, prebrief)
		const relativePath = filePath.startsWith(BITES_DIR)
			? filePath.replace(`${BITES_DIR}/`, '')
			: filePath
		lines.push(`- ✅ ${label} — \`${relativePath}\``)
	}

	if (highPriority.length === 0) {
		lines.push('')
		lines.push('No high-priority meetings found for tomorrow.')
		return lines.join('\n')
	}

	lines.push('')
	lines.push('Pre-briefs saved. Review before bed or in the morning.')
	return lines.join('\n')
}

/**
 * Get a specific calendar event by ID
 */
export const getEventById = async (
	eventId: string,
	email = DEFAULT_CALENDAR_EMAIL,
	calendarId = DEFAULT_CALENDAR_ID
): Promise<CalendarEvent | null> => {
	try {
		const output = execSync(
			`${GCCLI_PATH} ${email} event ${calendarId} ${eventId}`,
			{ encoding: 'utf-8', timeout: 30000 }
		)
		return parseEventOutput(output)
	} catch (err) {
		logError('[prebrief] Failed to get event:', err)
		return null
	}
}

/**
 * Search for relevant files in workspace based on attendees/topics
 */
const findRelatedFiles = async (event: CalendarEvent): Promise<string[]> => {
	const searchTerms: string[] = []
	
	// Extract names from attendees
	if (event.attendees) {
		for (const email of event.attendees) {
			const name = email.split('@')[0]?.replace(/[._]/g, ' ')
			if (name) searchTerms.push(name)
		}
	}
	
	// Extract words from summary
	const summaryWords = event.summary
		.replace(/[^\w\s]/g, ' ')
		.split(/\s+/)
		.filter(w => w.length > 3)
	searchTerms.push(...summaryWords)
	
	const relatedFiles: string[] = []
	
	// Search in memory and drafts directories
	const searchDirs = [
		join(BITES_DIR, 'memory'),
		join(BITES_DIR, 'drafts'),
		join(BITES_DIR, 'specs'),
	]
	
	for (const dir of searchDirs) {
		try {
			const files = await readdir(dir, { recursive: true })
			for (const file of files) {
				if (!file.endsWith('.md')) continue
				const filePath = join(dir, file)
				const content = await readFile(filePath, 'utf-8').catch(() => '')
				const contentLower = content.toLowerCase()
				const fileNameLower = file.toLowerCase()
				
				for (const term of searchTerms) {
					if (contentLower.includes(term.toLowerCase()) || 
						fileNameLower.includes(term.toLowerCase())) {
						relatedFiles.push(filePath.replace(BITES_DIR + '/', ''))
						break
					}
				}
			}
		} catch {
			// Directory might not exist
		}
	}
	
	return [...new Set(relatedFiles)].slice(0, 10) // Limit to 10 most relevant
}

/**
 * Read content from related files for context
 */
const readRelatedFilesSummary = async (files: string[]): Promise<string> => {
	const summaries: string[] = []
	
	for (const file of files.slice(0, 5)) {
		try {
			const content = await readFile(join(BITES_DIR, file), 'utf-8')
			// Get first 500 chars as summary
			const summary = content.slice(0, 500).replace(/\n+/g, ' ').trim()
			summaries.push(`**${file}**: ${summary}${content.length > 500 ? '...' : ''}`)
		} catch {
			// Skip files that can't be read
		}
	}
	
	return summaries.join('\n\n')
}

/**
 * Generate a pre-brief document for a calendar event
 */
export const generatePrebrief = async (event: CalendarEvent): Promise<string> => {
	const relatedFiles = await findRelatedFiles(event)
	const relatedContent = await readRelatedFilesSummary(relatedFiles)
	
	// Format event time
	const startDate = new Date(event.start)
	const formattedDate = startDate.toLocaleDateString('en-GB', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	})
	const formattedTime = startDate.toLocaleTimeString('en-GB', {
		hour: '2-digit',
		minute: '2-digit',
	})
	
	// Build the prebrief document
	const sections: string[] = []
	
	// Header
	sections.push(`# Pre-brief: ${event.summary}`)
	sections.push(`**Date:** ${formattedDate} at ${formattedTime} UK`)
	sections.push('')
	
	// Event details
	sections.push('## Event Details')
	if (event.location) {
		sections.push(`- **Location:** ${event.location}`)
	}
	if (event.attendees && event.attendees.length > 0) {
		sections.push(`- **Attendees:** ${event.attendees.join(', ')}`)
	}
	if (event.description) {
		sections.push(`- **Description:** ${event.description.slice(0, 500)}${event.description.length > 500 ? '...' : ''}`)
	}
	sections.push('')
	
	// Context section
	sections.push('## Context')
	if (relatedFiles.length > 0) {
		sections.push('Related files found in workspace:')
		for (const file of relatedFiles) {
			sections.push(`- ${file}`)
		}
	} else {
		sections.push('No directly related files found in workspace.')
	}
	sections.push('')
	
	// Related content section
	if (relatedContent) {
		sections.push('## Related Content')
		sections.push(relatedContent)
		sections.push('')
	}
	
	// Preparation checklist
	sections.push('## Preparation Checklist')
	sections.push('- [ ] Review related files listed above')
	sections.push('- [ ] Prepare talking points')
	sections.push('- [ ] Draft questions to ask')
	sections.push('- [ ] Check current status/blockers')
	sections.push('')
	
	// Talking points placeholder
	sections.push('## Talking Points')
	sections.push('*(Add your talking points here)*')
	sections.push('')
	
	// Questions placeholder
	sections.push('## Questions to Ask')
	sections.push('*(Add questions you want to raise)*')
	sections.push('')
	
	// Footer
	sections.push('---')
	sections.push(`*Generated: ${new Date().toISOString()}*`)
	
	return sections.join('\n')
}

/**
 * Save prebrief to file
 */
const savePrebriefFile = async (event: CalendarEvent, content: string): Promise<string> => {
	await mkdir(PREBRIEFS_DIR, { recursive: true })
	
	// Create filename: YYYY-MM-DD-slug.md
	const startDate = new Date(event.start)
	const dateStr = startDate.toISOString().split('T')[0]
	const slug = event.summary
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
		.slice(0, 40)
	
	const filename = `${dateStr}-${slug}.md`
	const filePath = join(PREBRIEFS_DIR, filename)
	
	await writeFile(filePath, content, 'utf-8')
	return filePath
}

/**
 * Main function: Generate prebrief for an event ID or search term
 */
export const createPrebrief = async (query: string): Promise<PrebriefResult> => {
	// First try to find event by ID or partial match
	const todayEvents = await getTodayEvents()
	
	let event: CalendarEvent | null = null
	
	// Try exact ID match
	event = todayEvents.find(e => e.id === query) || null
	
	// Try partial ID match
	if (!event) {
		event = todayEvents.find(e => e.id.includes(query)) || null
	}
	
	// Try summary match (case-insensitive)
	if (!event) {
		const queryLower = query.toLowerCase()
		event = todayEvents.find(e => 
			e.summary.toLowerCase().includes(queryLower)
		) || null
	}
	
	// Try attendee match
	if (!event) {
		const queryLower = query.toLowerCase()
		event = todayEvents.find(e => 
			e.attendees?.some(a => a.toLowerCase().includes(queryLower))
		) || null
	}
	
	if (!event) {
		// List available events for today
		if (todayEvents.length > 0) {
			const eventList = todayEvents.map(e => {
				const time = new Date(e.start).toLocaleTimeString('en-GB', { 
					hour: '2-digit', 
					minute: '2-digit' 
				})
				return `  • ${time} - ${e.summary}`
			}).join('\n')
			return {
				success: false,
				error: `Event not found: "${query}"\n\nToday's events:\n${eventList}\n\nTry: /prebrief <event name or time>`,
			}
		}
		return {
			success: false,
			error: `Event not found: "${query}"\n\nNo events found for today.`,
		}
	}
	
	// Generate the prebrief
	const prebrief = await generatePrebrief(event)
	const filePath = await savePrebriefFile(event, prebrief)
	
	return {
		success: true,
		event,
		prebrief,
		filePath,
	}
}

/**
 * List today's events (for /prebrief with no args)
 */
export const listTodayEvents = async (): Promise<string> => {
	const events = await getTodayEvents()
	
	if (events.length === 0) {
		return 'No events scheduled for today.'
	}
	
	const lines = ['📅 Today\'s events:', '']
	
	for (const event of events) {
		const time = new Date(event.start).toLocaleTimeString('en-GB', {
			hour: '2-digit',
			minute: '2-digit',
		})
		const attendees = event.attendees?.length 
			? ` (${event.attendees.length} attendees)`
			: ''
		lines.push(`• **${time}** - ${event.summary}${attendees}`)
	}
	
	lines.push('')
	lines.push('Use `/prebrief <event name>` to generate a pre-brief.')
	
	return lines.join('\n')
}
