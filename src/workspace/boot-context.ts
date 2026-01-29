import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const safeRead = async (path: string): Promise<string | null> => {
	try {
		return await readFile(path, 'utf-8')
	} catch {
		return null
	}
}

const formatSection = (title: string, body: string): string => {
	const trimmed = body.trimEnd()
	return [`## ${title}`, '```', trimmed, '```'].join('\n')
}

const truncate = (text: string, maxChars: number): { text: string; truncated: boolean } => {
	if (text.length <= maxChars) return { text, truncated: false }
	return { text: text.slice(0, maxChars), truncated: true }
}

const utcDateString = (d: Date): string => d.toISOString().slice(0, 10)

export type BootContextOptions = {
	maxCharsPerFile?: number
}

/**
 * Deterministic boot context per workspace contract:
 * - SOUL.md
 * - USER.md
 * - MEMORY.md
 * - memory/YYYY-MM-DD.md (today + yesterday)
 */
export const buildBootContext = async (
	workspaceDir: string,
	options: BootContextOptions = {}
): Promise<string | null> => {
	const maxCharsPerFile = options.maxCharsPerFile ?? 12_000
	const today = new Date()
	const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
	const todayKey = utcDateString(today)
	const yesterdayKey = utcDateString(yesterday)

	const files: Array<{ title: string; path: string }> = [
		{ title: 'SOUL.md', path: join(workspaceDir, 'SOUL.md') },
		{ title: 'USER.md', path: join(workspaceDir, 'USER.md') },
		{ title: 'MEMORY.md', path: join(workspaceDir, 'MEMORY.md') },
		{ title: `memory/${todayKey}.md`, path: join(workspaceDir, 'memory', `${todayKey}.md`) },
		{ title: `memory/${yesterdayKey}.md`, path: join(workspaceDir, 'memory', `${yesterdayKey}.md`) },
	]

	const sections: string[] = []
	for (const f of files) {
		const raw = await safeRead(f.path)
		if (!raw) continue
		const { text, truncated } = truncate(raw, maxCharsPerFile)
		const suffix = truncated ? `\n\n[...truncated to ${maxCharsPerFile} chars]` : ''
		sections.push(formatSection(f.title, text + suffix))
	}

	if (sections.length === 0) return null
	return [
		'BOOT CONTEXT (read-only; injected from workspace files; do not edit):',
		...sections,
	].join('\n\n')
}
