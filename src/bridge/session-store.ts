import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { ResumeToken } from './jsonl-session.js'

const CONFIG_DIR = join(homedir(), '.config', 'tg-gateway')
const SESSIONS_DIR = join(CONFIG_DIR, 'sessions')
const RESUME_TOKENS_PATH = join(CONFIG_DIR, 'resume-tokens.json')

type ResumeTokenStore = {
	version: 1
	tokens: Record<string, ResumeToken> // key: `${chatId}:${cli}`
	activeCli: Record<string, string> // key: chatId
}

type SessionLogEntry = {
	timestamp: string
	chatId: string | number
	role: 'user' | 'assistant' | 'system'
	text: string
	sessionId?: string
	cli?: string
}

const DEFAULT_STORE: ResumeTokenStore = { version: 1, tokens: {}, activeCli: {} }

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
	
	getResumeToken: (chatId: number | string, cli: string) => ResumeToken | undefined
	setResumeToken: (chatId: number | string, cli: string, token: ResumeToken) => Promise<void>
	getActiveCli: (chatId: number | string) => string | undefined
	setActiveCli: (chatId: number | string, cli: string) => Promise<void>
	logMessage: (chatId: number | string, role: 'user' | 'assistant', text: string, sessionId?: string, cli?: string) => Promise<void>
}

export const createPersistentSessionStore = async (): Promise<PersistentSessionStore> => {
	const stored = await loadResumeTokens()
	const resumeTokens = new Map(Object.entries(stored.tokens))
	const activeCli = new Map(Object.entries(stored.activeCli))

	const persist = async () => {
		const store: ResumeTokenStore = {
			version: 1,
			tokens: Object.fromEntries(resumeTokens),
			activeCli: Object.fromEntries(activeCli),
		}
		await saveResumeTokens(store)
	}

	return {
		resumeTokens,
		activeCli,
		
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
		
		logMessage: async (chatId, role, text, sessionId, cli) => {
			await logSessionMessage({
				timestamp: new Date().toISOString(),
				chatId,
				role,
				text,
				sessionId,
				cli,
			})
		},
	}
}
