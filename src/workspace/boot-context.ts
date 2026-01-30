import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const BOOT_CONTEXT_HEAD_RATIO = 0.7
const BOOT_CONTEXT_TAIL_RATIO = 0.2

const getEnvInt = (name: string, fallback: number): number => {
	const raw = process.env[name]
	if (!raw) return fallback
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) ? parsed : fallback
}

const DEFAULT_BOOT_CONTEXT_MAX_CHARS = getEnvInt('TG_GATEWAY_BOOT_CONTEXT_MAX_CHARS', 20_000)

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

const truncate = (
	text: string,
	maxChars: number,
	fileName: string
): { text: string; truncated: boolean } => {
	const trimmed = text.trimEnd()
	if (trimmed.length <= maxChars) return { text: trimmed, truncated: false }
	const headChars = Math.floor(maxChars * BOOT_CONTEXT_HEAD_RATIO)
	const tailChars = Math.floor(maxChars * BOOT_CONTEXT_TAIL_RATIO)
	const head = trimmed.slice(0, headChars)
	const tail = trimmed.slice(-tailChars)
	const marker = [
		'',
		`[...truncated, read ${fileName} for full content...]`,
		`…(truncated ${fileName}: kept ${headChars}+${tailChars} chars of ${trimmed.length})…`,
		'',
	].join('\n')
	return { text: `${head}\n${marker}\n${tail}`, truncated: true }
}

export type BootContextMode = 'main' | 'subagent'

export type BootContextOptions = {
	maxCharsPerFile?: number
	mode?: BootContextMode
}

const buildBootContextFiles = (workspaceDir: string, mode: BootContextMode) => {
	if (mode === 'subagent') {
		return [
			{ title: 'AGENTS.md', path: join(workspaceDir, 'AGENTS.md') },
			{ title: 'TOOLS.md', path: join(workspaceDir, 'TOOLS.md') },
		]
	}
	return [
		{ title: 'AGENTS.md', path: join(workspaceDir, 'AGENTS.md') },
		{ title: 'SOUL.md', path: join(workspaceDir, 'SOUL.md') },
		{ title: 'TOOLS.md', path: join(workspaceDir, 'TOOLS.md') },
		{ title: 'IDENTITY.md', path: join(workspaceDir, 'IDENTITY.md') },
		{ title: 'USER.md', path: join(workspaceDir, 'USER.md') },
		{ title: 'HEARTBEAT.md', path: join(workspaceDir, 'HEARTBEAT.md') },
		{ title: 'BOOTSTRAP.md', path: join(workspaceDir, 'BOOTSTRAP.md') },
	]
}

/**
 * Deterministic boot context per workspace contract.
 * Main sessions: AGENTS, SOUL, TOOLS, IDENTITY, USER, HEARTBEAT, BOOTSTRAP.
 * Subagents: AGENTS, TOOLS.
 */
export const buildBootContext = async (
	workspaceDir: string,
	options: BootContextOptions = {}
): Promise<string | null> => {
	const maxCharsPerFile = options.maxCharsPerFile ?? DEFAULT_BOOT_CONTEXT_MAX_CHARS
	const mode = options.mode ?? 'main'
	const files = buildBootContextFiles(workspaceDir, mode)

	const sections: string[] = []
	for (const f of files) {
		const raw = await safeRead(f.path)
		if (!raw) continue
		const { text } = truncate(raw, maxCharsPerFile, f.title)
		sections.push(formatSection(f.title, text))
	}

	if (sections.length === 0) return null
	return [
		'BOOT CONTEXT (read-only; injected from workspace files; do not edit):',
		...sections,
	].join('\n\n')
}
