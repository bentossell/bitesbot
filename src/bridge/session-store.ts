import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { ResumeToken } from './jsonl-session.js'

// Default paths (can be overridden with workspace)
const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'tg-gateway')

let SESSIONS_DIR = join(DEFAULT_CONFIG_DIR, 'sessions')
let RESUME_TOKENS_PATH = join(DEFAULT_CONFIG_DIR, 'resume-tokens.json')

export const setWorkspaceDir = (workspaceDir: string) => {
	SESSIONS_DIR = join(workspaceDir, 'sessions')
	RESUME_TOKENS_PATH = join(workspaceDir, '.state', 'resume-tokens.json')
}

export type ChatSettings = {
	streaming: boolean
	verbose: boolean
	model?: string // Selected model ID (e.g., claude-opus-4-5-20251101)
}

type ResumeTokenStore = {
	version: 1
	tokens: Record<string, ResumeToken> // key: `${chatId}:${cli}`
	activeCli: Record<string, string> // key: chatId
	chatSettings: Record<string, ChatSettings> // key: chatId
}

export type SessionLogMeta = {
	subagent?: {
		runId: string
		label?: string
		status?: string
		cli?: string
	}
}

export type SessionLogEntry = {
	timestamp: string
	chatId: string | number
	role: 'user' | 'assistant' | 'system'
	text: string
	sessionId?: string
	cli?: string
	meta?: SessionLogMeta
}

const DEFAULT_STORE: ResumeTokenStore = { version: 1, tokens: {}, activeCli: {}, chatSettings: {} }
// Note: verbose is a hidden feature (off by default) - shows tool names/outputs
const DEFAULT_CHAT_SETTINGS: ChatSettings = { streaming: false, verbose: false }

export const loadResumeTokens = async (): Promise<ResumeTokenStore> => {
	try {
		const data = await readFile(RESUME_TOKENS_PATH, 'utf-8')
		return JSON.parse(data) as ResumeTokenStore
	} catch {
		return { ...DEFAULT_STORE }
	}
}

export const saveResumeTokens = async (store: ResumeTokenStore): Promise<void> => {
	await mkdir(dirname(RESUME_TOKENS_PATH), { recursive: true })
	await writeFile(RESUME_TOKENS_PATH, JSON.stringify(store, null, 2), 'utf-8')
}

export const logSessionMessage = async (entry: SessionLogEntry): Promise<void> => {
	const date = new Date().toISOString().split('T')[0] // YYYY-MM-DD
	const logPath = join(SESSIONS_DIR, `${date}.jsonl`)
	
	await mkdir(SESSIONS_DIR, { recursive: true })
	await appendFile(logPath, JSON.stringify(entry) + '\n', 'utf-8')
}

export type PersistentSessionStore = {
	resumeTokens: Map<string, ResumeToken>
	activeCli: Map<string, string>
	chatSettings: Map<string, ChatSettings>
	
	getResumeToken: (chatId: number | string, cli: string) => ResumeToken | undefined
	setResumeToken: (chatId: number | string, cli: string, token: ResumeToken) => Promise<void>
	getActiveCli: (chatId: number | string) => string | undefined
	setActiveCli: (chatId: number | string, cli: string) => Promise<void>
	getChatSettings: (chatId: number | string) => ChatSettings
	setChatSettings: (chatId: number | string, settings: Partial<ChatSettings>) => Promise<void>
	logMessage: (
		chatId: number | string,
		role: 'user' | 'assistant',
		text: string,
		sessionId?: string,
		cli?: string,
		meta?: SessionLogMeta
	) => Promise<void>
}

export const createPersistentSessionStore = async (): Promise<PersistentSessionStore> => {
	const stored = await loadResumeTokens()
	const resumeTokens = new Map(Object.entries(stored.tokens))
	const activeCli = new Map(Object.entries(stored.activeCli))
	const chatSettings = new Map<string, ChatSettings>(
		Object.entries(stored.chatSettings ?? {})
	)

	const persist = async () => {
		const store: ResumeTokenStore = {
			version: 1,
			tokens: Object.fromEntries(resumeTokens),
			activeCli: Object.fromEntries(activeCli),
			chatSettings: Object.fromEntries(chatSettings),
		}
		await saveResumeTokens(store)
	}

	return {
		resumeTokens,
		activeCli,
		chatSettings,
		
		getResumeToken: (chatId, cli) => resumeTokens.get(`${chatId}:${cli}`),
		
		setResumeToken: async (chatId, cli, token) => {
			resumeTokens.set(`${chatId}:${cli}`, token)
			await persist()
		},
		
		getActiveCli: (chatId) => activeCli.get(String(chatId)),
		
		setActiveCli: async (chatId, cli) => {
			activeCli.set(String(chatId), cli)
			await persist()
		},
		
		getChatSettings: (chatId) => {
			const key = String(chatId)
			return chatSettings.get(key) ?? { ...DEFAULT_CHAT_SETTINGS }
		},
		
		setChatSettings: async (chatId, settings) => {
			const key = String(chatId)
			const current = chatSettings.get(key) ?? { ...DEFAULT_CHAT_SETTINGS }
			chatSettings.set(key, { ...current, ...settings })
			await persist()
		},
		
		logMessage: async (chatId, role, text, sessionId, cli, meta) => {
			await logSessionMessage({
				timestamp: new Date().toISOString(),
				chatId,
				role,
				text,
				sessionId,
				cli,
				meta,
			})
		},
	}
}
