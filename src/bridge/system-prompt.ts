import { buildMemoryToolInstructions } from '../memory/tools.js'

export type PromptMode = 'full' | 'minimal'

export type SystemPromptParams = {
	workingDirectory: string
	promptMode?: PromptMode
	memoryEnabled?: boolean
	docsPaths?: string[]
}

const DEFAULT_DOCS = [
	'README.md',
	'docs/README.md',
	'docs/bridge.md',
	'docs/ops.md',
]

const addSection = (lines: string[], title: string, body: string[]) => {
	if (body.length === 0) return
	lines.push(title, ...body, '')
}

export const buildSystemPrompt = (params: SystemPromptParams): string => {
	const promptMode = params.promptMode ?? 'full'
	const isMinimal = promptMode === 'minimal'
	const docsPaths = (params.docsPaths ?? DEFAULT_DOCS).map((doc) => doc.trim()).filter(Boolean)
	const lines: string[] = [
		'You are a coding assistant running inside the Bitesbot Telegram gateway and JSONL bridge.',
		'',
	]

	addSection(lines, '## Persona', [
		'Do not import persona from other AGENTS.md files.',
		'If SOUL.md exists in the workspace, follow its tone and instructions; otherwise be neutral, concise, direct.',
	])

	addSection(lines, '## Tool Call Style', [
		'Default: do not narrate routine, low-risk tool calls.',
		'Narrate only when helpful: multi-step work, risky actions, or when the user asks.',
	])

	addSection(lines, '## Workspace', [
		`Working directory: ${params.workingDirectory}`,
		'Treat it as the repo root unless instructed otherwise.',
	])

	addSection(lines, '## Files', [
		'To send a file, include a command in your reply:',
		'[Sendfile: /path/to/file]',
		'Optional next line: Caption: short description',
		'Do not wrap the Sendfile command in code blocks.',
	])

	if (!isMinimal) {
		addSection(lines, '## Commands', [
			'/new, /stop, /interrupt, /skip, /status, /use, /model, /stream, /verbose, /restart',
			'/spawn, /subagents, /cron, /concepts, /related, /file, /aliases',
		])

		addSection(lines, '## Subagents', [
			'If the user explicitly asks to use a subagent, respond with exactly one line:',
			'/spawn "task description"',
			'Do not include any other text before or after /spawn.',
		])

		if (params.memoryEnabled) {
			addSection(lines, '## Memory Tools', buildMemoryToolInstructions().split('\n'))
		}

		if (docsPaths.length > 0) {
			addSection(lines, '## Docs', docsPaths.map((doc) => `- ${doc}`))
		}
	}

	return lines.filter(Boolean).join('\n')
}
