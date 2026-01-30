import { EventEmitter } from 'node:events'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export type SessionStatus = 'active' | 'idle' | 'completed'

export interface SessionInfo {
	id: string
	name: string
	chatId: string | number
	adapter: string
	model?: string
	status: SessionStatus
	startedAt: number
	lastActivityAt: number
	messageCount: number
	tags?: string[]
	metadata?: Record<string, unknown>
}

export interface SessionMessage {
	timestamp: string
	role: 'user' | 'assistant' | 'system'
	text: string
}

export type SessionLifecycleEvent =
	| { type: 'session:start'; session: SessionInfo }
	| { type: 'session:message'; sessionId: string; role: 'user' | 'assistant' | 'system'; text: string }
	| { type: 'session:idle'; sessionId: string; idleMinutes: number }
	| { type: 'session:end'; sessionId: string; reason: 'explicit' | 'expired' | 'replaced' }
	| { type: 'session:resume'; sessionId: string; fromToken: string }
	| { type: 'session:tagged'; sessionId: string; tags: string[] }

export type SessionRegistryEvents = { event: [SessionLifecycleEvent] }

const DEFAULT_IDLE_MINUTES = 30
const DEFAULT_EXPIRY_HOURS = 24
const MAX_REGISTRY_AGE_DAYS = 7
const MAX_MESSAGES_PER_SESSION = 100
const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'tg-gateway')
let REGISTRY_PATH = join(DEFAULT_CONFIG_DIR, 'session-registry.json')

export const setRegistryDir = (workspaceDir: string) => {
	REGISTRY_PATH = join(workspaceDir, '.state', 'session-registry.json')
}

interface RegistryStore { version: 1; sessions: Record<string, SessionInfo>; history: Record<string, SessionMessage[]> }

export class SessionRegistry extends EventEmitter<SessionRegistryEvents> {
	private sessions: Map<string, SessionInfo> = new Map()
	private history: Map<string, SessionMessage[]> = new Map()
	private idleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
	private expiryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

	constructor(private idleMinutes = DEFAULT_IDLE_MINUTES, private expiryHours = DEFAULT_EXPIRY_HOURS) { super() }

	async load(): Promise<void> {
		try {
			const data = await readFile(REGISTRY_PATH, 'utf-8')
			const store = JSON.parse(data) as RegistryStore
			this.sessions = new Map(Object.entries(store.sessions || {}))
			this.history = new Map(Object.entries(store.history || {}))
			this.pruneExpired()
		} catch {
			this.sessions = new Map()
			this.history = new Map()
		}
	}

	async save(): Promise<void> {
		await mkdir(dirname(REGISTRY_PATH), { recursive: true })
		const store: RegistryStore = { version: 1, sessions: Object.fromEntries(this.sessions), history: Object.fromEntries(this.history) }
		await writeFile(REGISTRY_PATH, JSON.stringify(store, null, 2), 'utf-8')
	}

	start(opts: { chatId: string | number; adapter: string; name?: string; model?: string; tags?: string[]; metadata?: Record<string, unknown> }): SessionInfo {
		const now = Date.now()
		const id = `${opts.chatId}-${now}`
		const session: SessionInfo = { id, name: opts.name || 'main', chatId: opts.chatId, adapter: opts.adapter, model: opts.model, status: 'active', startedAt: now, lastActivityAt: now, messageCount: 0, tags: opts.tags, metadata: opts.metadata }
		this.sessions.set(id, session)
		this.history.set(id, [])
		this.resetIdleTimer(id)
		this.emit('event', { type: 'session:start', session })
		void this.save()
		return session
	}

	recordMessage(sessionId: string, role: 'user' | 'assistant' | 'system', text: string): void {
		const session = this.sessions.get(sessionId)
		if (!session) return
		session.lastActivityAt = Date.now()
		session.messageCount++
		if (session.status === 'idle') session.status = 'active'
		const messages = this.history.get(sessionId) || []
		messages.push({ timestamp: new Date().toISOString(), role, text })
		if (messages.length > MAX_MESSAGES_PER_SESSION) messages.splice(0, messages.length - MAX_MESSAGES_PER_SESSION)
		this.history.set(sessionId, messages)
		this.resetIdleTimer(sessionId)
		this.emit('event', { type: 'session:message', sessionId, role, text })
		void this.save()
	}

	get(sessionId: string): SessionInfo | undefined { return this.sessions.get(sessionId) }
	findByChat(chatId: string | number): SessionInfo[] { return Array.from(this.sessions.values()).filter(s => String(s.chatId) === String(chatId)).sort((a, b) => b.lastActivityAt - a.lastActivityAt) }
	findActiveByChat(chatId: string | number): SessionInfo | undefined { return this.findByChat(chatId).find(s => s.status === 'active') }

	list(opts?: { tags?: string[]; status?: SessionStatus; chatId?: string | number }): SessionInfo[] {
		let sessions = Array.from(this.sessions.values())
		if (opts?.chatId !== undefined) sessions = sessions.filter(s => String(s.chatId) === String(opts.chatId))
		if (opts?.status) sessions = sessions.filter(s => s.status === opts.status)
		if (opts?.tags && opts.tags.length > 0) sessions = sessions.filter(s => s.tags && opts.tags!.some(t => s.tags!.includes(t)))
		return sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
	}

	getHistory(sessionId: string, opts?: { limit?: number; before?: string }): SessionMessage[] {
		const messages = this.history.get(sessionId) || []
		let result = [...messages]
		if (opts?.before) { const idx = result.findIndex(m => m.timestamp >= opts.before!); if (idx > 0) result = result.slice(0, idx) }
		if (opts?.limit && opts.limit > 0) result = result.slice(-opts.limit)
		return result
	}

	tag(sessionId: string, tags: string[]): void {
		const session = this.sessions.get(sessionId)
		if (!session) return
		const existing = new Set(session.tags || [])
		for (const tag of tags) existing.add(tag.toLowerCase().trim())
		session.tags = Array.from(existing)
		this.emit('event', { type: 'session:tagged', sessionId, tags: session.tags })
		void this.save()
	}

	untag(sessionId: string, tags: string[]): void {
		const session = this.sessions.get(sessionId)
		if (!session || !session.tags) return
		const toRemove = new Set(tags.map(t => t.toLowerCase().trim()))
		session.tags = session.tags.filter(t => !toRemove.has(t))
		void this.save()
	}

	end(sessionId: string, reason: 'explicit' | 'expired' | 'replaced' = 'explicit'): void {
		const session = this.sessions.get(sessionId)
		if (!session) return
		session.status = 'completed'
		this.clearTimers(sessionId)
		this.emit('event', { type: 'session:end', sessionId, reason })
		void this.save()
	}

	markResumed(sessionId: string, fromToken: string): void {
		const session = this.sessions.get(sessionId)
		if (!session) return
		session.status = 'active'
		session.lastActivityAt = Date.now()
		this.resetIdleTimer(sessionId)
		this.emit('event', { type: 'session:resume', sessionId, fromToken })
		void this.save()
	}

	getContextForResume(chatId: string | number, limit = 10): SessionMessage[] {
		const sessions = this.findByChat(chatId)
		const messages: SessionMessage[] = []
		for (const session of sessions) messages.push(...(this.history.get(session.id) || []))
		return messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-limit)
	}

	clear(): void {
		for (const id of this.sessions.keys()) this.clearTimers(id)
		this.sessions.clear()
		this.history.clear()
	}

	private resetIdleTimer(sessionId: string): void {
		const existingIdle = this.idleTimers.get(sessionId)
		if (existingIdle) clearTimeout(existingIdle)
		const existingExpiry = this.expiryTimers.get(sessionId)
		if (existingExpiry) clearTimeout(existingExpiry)
		const idleTimer = setTimeout(() => this.markIdle(sessionId), this.idleMinutes * 60 * 1000)
		this.idleTimers.set(sessionId, idleTimer)
	}

	private markIdle(sessionId: string): void {
		const session = this.sessions.get(sessionId)
		if (!session || session.status !== 'active') return
		session.status = 'idle'
		this.emit('event', { type: 'session:idle', sessionId, idleMinutes: this.idleMinutes })
		const expiryTimer = setTimeout(() => this.end(sessionId, 'expired'), this.expiryHours * 60 * 60 * 1000)
		this.expiryTimers.set(sessionId, expiryTimer)
		void this.save()
	}

	private clearTimers(sessionId: string): void {
		const idleTimer = this.idleTimers.get(sessionId)
		if (idleTimer) { clearTimeout(idleTimer); this.idleTimers.delete(sessionId) }
		const expiryTimer = this.expiryTimers.get(sessionId)
		if (expiryTimer) { clearTimeout(expiryTimer); this.expiryTimers.delete(sessionId) }
	}

	private pruneExpired(): void {
		const cutoff = Date.now() - MAX_REGISTRY_AGE_DAYS * 24 * 60 * 60 * 1000
		for (const [id, session] of this.sessions) {
			if (session.status === 'completed' && session.lastActivityAt < cutoff) {
				this.sessions.delete(id)
				this.history.delete(id)
			}
		}
	}
}

let registryInstance: SessionRegistry | null = null

export const getSessionRegistry = async (): Promise<SessionRegistry> => {
	if (!registryInstance) {
		registryInstance = new SessionRegistry()
		await registryInstance.load()
	}
	return registryInstance
}

export const createSessionRegistry = (idleMinutes = DEFAULT_IDLE_MINUTES, expiryHours = DEFAULT_EXPIRY_HOURS): SessionRegistry => {
	return new SessionRegistry(idleMinutes, expiryHours)
}
