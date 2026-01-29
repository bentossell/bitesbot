import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface, type Interface } from 'node:readline'
import type { CLIManifest } from './manifest.js'

export type SessionState = 'active' | 'suspended' | 'completed'

export type ResumeToken = {
	engine: string
	sessionId: string
}

// Claude Code events
export type ClaudeEvent =
	| { type: 'system'; subtype: string; session_id?: string; model?: string }
	| { type: 'assistant'; message: { content: ContentBlock[] }; parent_tool_use_id?: string }
	| { type: 'user'; message: { content: ContentBlock[] } }
	| { type: 'result'; session_id: string; result?: string; is_error: boolean; total_cost_usd?: number }

// Droid events
export type DroidEvent =
	| { type: 'system'; subtype: string; session_id?: string; model?: string }
	| { type: 'session_start'; session_id: string; model?: string }
	| { type: 'message'; role: 'user' | 'assistant'; text: string; session_id?: string }
	| { type: 'thinking'; text: string; session_id?: string }
	| { type: 'tool_call'; id: string; messageId?: string; toolId?: string; toolName: string; parameters?: Record<string, unknown>; timestamp?: number; session_id?: string }
	| { type: 'tool_result'; id: string; messageId?: string; toolId?: string; isError?: boolean; value?: string | Record<string, unknown>; error?: { type?: string; message?: string }; timestamp?: number; session_id?: string }
	| { type: 'tool_start'; tool: string; id: string; input: Record<string, unknown>; session_id?: string }
	| { type: 'tool_end'; id: string; output?: string; error?: string; session_id?: string }
	| { type: 'completion'; finalText: string; session_id?: string; numTurns?: number }

export type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content?: string | unknown[]; is_error?: boolean }
	| { type: 'thinking'; thinking: string }

type JsonlEvent = ClaudeEvent | DroidEvent

export type BridgeEvent =
	| { type: 'started'; sessionId: string; model?: string }
	| { type: 'tool_start'; toolId: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_end'; toolId: string; isError: boolean; preview?: string }
	| { type: 'thinking'; text: string }
	| { type: 'text'; text: string }
	| { type: 'completed'; sessionId: string; answer: string; isError: boolean; cost?: number }
	| { type: 'error'; message: string }
	| { type: 'spec_plan'; plan: string } // Emitted when agent exits spec mode with a plan

export type SessionInfo = {
	id: string
	chatId: number | string
	cli: string
	state: SessionState
	lastActivity: Date
	resumeToken?: ResumeToken
	isSubagent?: boolean
}

export type JsonlSessionEvents = {
	event: [BridgeEvent]
	exit: [number]
}

export class JsonlSession extends EventEmitter<JsonlSessionEvents> {
	readonly id: string
	readonly chatId: number | string
	readonly cli: string
	readonly isSubagent: boolean
	private process: ChildProcess | null = null
	private readline: Interface | null = null
	private _state: SessionState = 'suspended'
	private _lastActivity: Date = new Date()
	private _resumeToken?: ResumeToken
	private _lastText: string = ''
	private pendingTools: Map<string, { name: string; input: Record<string, unknown> }> = new Map()

	constructor(
		chatId: number | string,
		private manifest: CLIManifest,
		private workingDir: string,
		options?: { isSubagent?: boolean }
	) {
		super()
		this.id = `${chatId}-${Date.now()}`
		this.chatId = chatId
		this.cli = manifest.name
		this.isSubagent = options?.isSubagent ?? false
	}

	get state(): SessionState {
		return this._state
	}

	get lastActivity(): Date {
		return this._lastActivity
	}

	get resumeToken(): ResumeToken | undefined {
		return this._resumeToken
	}

	getInfo(): SessionInfo {
		return {
			id: this.id,
			chatId: this.chatId,
			cli: this.cli,
			state: this._state,
			lastActivity: this._lastActivity,
			resumeToken: this._resumeToken,
			isSubagent: this.isSubagent,
		}
	}

	run(prompt: string, resume?: ResumeToken, options?: { specMode?: boolean }): void {
		if (this.process) {
			console.log(`[jsonl-session] Process already running for ${this.chatId}`)
			return
		}

		const appendResumeArgs = (args: string[]) => {
			if (!resume?.sessionId) return
			const flag = this.manifest.resume?.flag ?? (this.cli === 'droid' ? '-s' : '--resume')
			args.push(flag, resume.sessionId)
		}

		let args: string[]

		if (this.cli === 'droid') {
			// Droid uses: droid exec --output-format stream-json --auto high "prompt"
			// Note: --auto and --skip-permissions-unsafe are mutually exclusive
			const hasSkipPerms = this.manifest.args.includes('--skip-permissions-unsafe')
			args = [
				'exec',
				'--output-format', 'stream-json',
				...(hasSkipPerms ? [] : ['--auto', 'high']),
				...this.manifest.args,
			]
			appendResumeArgs(args)
			// Add spec mode flag if enabled and configured
			if (options?.specMode && this.manifest.specMode?.flag) {
				const flagParts = this.manifest.specMode.flag.split(' ')
				args.push(...flagParts)
			}
			args.push(prompt)
		} else {
			// Claude uses: claude -p --output-format stream-json --verbose "prompt"
			args = [
				'-p',
				'--output-format', 'stream-json',
				'--verbose',
				...this.manifest.args,
			]
			appendResumeArgs(args)
			// Add spec mode flag if enabled and configured
			if (options?.specMode && this.manifest.specMode?.flag) {
				const flagParts = this.manifest.specMode.flag.split(' ')
				args.push(...flagParts)
			}
			args.push(prompt)
		}

		console.log(`[jsonl-session] Spawning: ${this.manifest.command} ${args.slice(0, -1).join(' ')} "<prompt>"`)
		console.log(`[jsonl-session] Working dir: ${this.workingDir}`)

		this.process = spawn(this.manifest.command, args, {
			cwd: this.workingDir,
			env: process.env,
			stdio: ['pipe', 'pipe', 'pipe'],
		})

		// Close stdin to signal we're done sending input
		this.process.stdin?.end()

		this._state = 'active'
		this._lastActivity = new Date()

		this.readline = createInterface({ input: this.process.stdout! })
		this.readline.on('line', (line) => this.handleLine(line))

		this.process.stderr?.on('data', (data) => {
			const text = data.toString().trim()
			if (text) {
				console.log(`[jsonl-session] stderr: ${text}`)
			}
		})

		this.process.on('exit', (code) => {
			console.log(`[jsonl-session] Process exited with code ${code}`)
			this._state = 'completed'
			this.process = null
			this.readline = null
			this.emit('exit', code ?? 0)
		})

		this.process.on('error', (err) => {
			console.error(`[jsonl-session] Process error:`, err)
			this.emit('event', { type: 'error', message: err.message })
		})
	}

	private handleLine(line: string): void {
		this._lastActivity = new Date()

		if (!line.trim()) return

		try {
			const event = JSON.parse(line) as ClaudeEvent
			this.translateEvent(event)
		} catch {
			console.log(`[jsonl-session] Non-JSON line: ${line.slice(0, 100)}`)
		}
	}

	private translateEvent(event: JsonlEvent): void {
		switch (event.type) {
			case 'system':
				if (event.subtype === 'init' && event.session_id) {
					this._resumeToken = { engine: this.cli, sessionId: event.session_id }
					this.emit('event', {
						type: 'started',
						sessionId: event.session_id,
						model: event.model,
					})
				}
				break

			// Claude: assistant message with content blocks
			case 'assistant':
				if ('message' in event && event.message?.content) {
					for (const block of event.message.content) {
						switch (block.type) {
							case 'text':
								this._lastText = block.text
								this.emit('event', { type: 'text', text: block.text })
								break
							case 'tool_use':
								this.pendingTools.set(block.id, { name: block.name, input: block.input })
								this.emit('event', {
									type: 'tool_start',
									toolId: block.id,
									name: block.name,
									input: block.input,
								})
								// Detect ExitSpecMode tool (used by Droid and Claude in spec mode)
								if (block.name === 'ExitSpecMode' && block.input) {
									const plan = (block.input as { plan?: string }).plan
									if (plan) {
										this.emit('event', { type: 'spec_plan', plan })
									}
								}
								break
							case 'thinking':
								this.emit('event', { type: 'thinking', text: block.thinking })
								break
						}
					}
				}
				break

			// Droid: message event
			case 'message':
				if ('role' in event && event.role === 'assistant' && event.text) {
					this._lastText = event.text
					this.emit('event', { type: 'text', text: event.text })
				}
				break

			// Droid: thinking event
			case 'thinking':
				if ('text' in event && event.text) {
					this.emit('event', { type: 'thinking', text: event.text })
				}
				break

			// Droid: session_start (alternative to system init)
			case 'session_start':
				if ('session_id' in event) {
					this._resumeToken = { engine: this.cli, sessionId: event.session_id }
					this.emit('event', {
						type: 'started',
						sessionId: event.session_id,
						model: event.model,
					})
				}
				break

			// Droid: tool_start
			case 'tool_start':
				if ('tool' in event) {
					this.pendingTools.set(event.id, { name: event.tool, input: event.input })
					this.emit('event', {
						type: 'tool_start',
						toolId: event.id,
						name: event.tool,
						input: event.input,
					})
					// Detect ExitSpecMode tool (used by Droid in spec mode)
					if (event.tool === 'ExitSpecMode' && event.input) {
						const plan = (event.input as { plan?: string }).plan
						if (plan) {
							this.emit('event', { type: 'spec_plan', plan })
						}
					}
				}
				break

			// Droid: tool_call (newer format)
			case 'tool_call': {
				const toolId = event.id || event.toolId || 'unknown'
				const input = event.parameters ?? {}
				this.pendingTools.set(toolId, { name: event.toolName, input })
				this.emit('event', {
					type: 'tool_start',
					toolId,
					name: event.toolName,
					input,
				})
				// Detect ExitSpecMode tool (used by Droid in spec mode)
				if (event.toolName === 'ExitSpecMode') {
					const plan = (input as { plan?: string }).plan
					if (plan) {
						this.emit('event', { type: 'spec_plan', plan })
					}
				}
				break
			}

			// Droid: tool_end
			case 'tool_end':
				if ('id' in event) {
					this.pendingTools.delete(event.id)
					this.emit('event', {
						type: 'tool_end',
						toolId: event.id,
						isError: !!event.error,
						preview: event.output,
					})
				}
				break

			// Droid: tool_result (newer format)
			case 'tool_result': {
				const toolId = event.id || event.toolId || 'unknown'
				this.pendingTools.delete(toolId)
				const output =
					typeof event.value === 'string'
						? event.value
						: event.value
							? JSON.stringify(event.value)
							: undefined
				this.emit('event', {
					type: 'tool_end',
					toolId,
					isError: !!event.isError,
					preview: output ?? event.error?.message,
				})
				break
			}

			// Claude: user message (tool results)
			case 'user':
				if ('message' in event && Array.isArray(event.message?.content)) {
					for (const block of event.message.content) {
						if (block.type === 'tool_result') {
							this.pendingTools.delete(block.tool_use_id)
							const preview = typeof block.content === 'string'
								? block.content
								: undefined
							this.emit('event', {
								type: 'tool_end',
								toolId: block.tool_use_id,
								isError: block.is_error ?? false,
								preview,
							})
						}
					}
				}
				break

			// Claude: result
			case 'result':
				if ('session_id' in event) {
					this._resumeToken = { engine: this.cli, sessionId: event.session_id }
					this.emit('event', {
						type: 'completed',
						sessionId: event.session_id,
						answer: event.result || this._lastText,
						isError: event.is_error,
						cost: event.total_cost_usd,
					})
				}
				break

			// Droid: completion
			case 'completion':
				if ('finalText' in event) {
					const sessionId = event.session_id || this._resumeToken?.sessionId || 'unknown'
					this._resumeToken = { engine: this.cli, sessionId }
					this.emit('event', {
						type: 'completed',
						sessionId,
						answer: event.finalText || this._lastText,
						isError: false,
					})
				}
				break
		}
	}

	terminate(): void {
		if (this.process) {
			const proc = this.process
			// Try SIGTERM first, then force kill after 500ms if still running
			proc.kill('SIGTERM')
			const killTimer = setTimeout(() => {
				try {
					proc.kill('SIGKILL')
				} catch {
					// Already dead
				}
			}, 500)
			// Cancel the SIGKILL timer if process exits cleanly
			proc.once('exit', () => clearTimeout(killTimer))
			this.process = null
		}
		this.readline = null
		this._state = 'suspended'
	}
}

export type QueuedMessage = {
	id: string
	text: string
	attachments?: Array<{ localPath?: string }>
	createdAt: number
}

export type SessionStore = {
	sessions: Map<number | string, JsonlSession>
	resumeTokens: Map<string, ResumeToken> // key: `${chatId}:${cli}`
	activeCli: Map<number | string, string> // tracks which CLI is active per chat
	messageQueue: Map<number | string, QueuedMessage[]> // queued messages per chat
	get: (chatId: number | string) => JsonlSession | undefined
	set: (session: JsonlSession) => void
	delete: (chatId: number | string) => void
	getResumeToken: (chatId: number | string, cli: string) => ResumeToken | undefined
	setResumeToken: (chatId: number | string, cli: string, token: ResumeToken) => void
	getActiveCli: (chatId: number | string) => string | undefined
	setActiveCli: (chatId: number | string, cli: string) => void
	isBusy: (chatId: number | string) => boolean
	enqueue: (chatId: number | string, msg: QueuedMessage) => void
	dequeue: (chatId: number | string) => QueuedMessage | undefined
	getQueueLength: (chatId: number | string) => number
}

export const createSessionStore = (): SessionStore => {
	const sessions = new Map<number | string, JsonlSession>()
	const resumeTokens = new Map<string, ResumeToken>()
	const activeCli = new Map<number | string, string>()
	const messageQueue = new Map<number | string, QueuedMessage[]>()

	return {
		sessions,
		resumeTokens,
		activeCli,
		messageQueue,
		get: (chatId) => sessions.get(chatId),
		set: (session) => sessions.set(session.chatId, session),
		delete: (chatId) => sessions.delete(chatId),
		getResumeToken: (chatId, cli) => resumeTokens.get(`${chatId}:${cli}`),
		setResumeToken: (chatId, cli, token) => resumeTokens.set(`${chatId}:${cli}`, token),
		getActiveCli: (chatId) => activeCli.get(chatId),
		setActiveCli: (chatId, cli) => activeCli.set(chatId, cli),
		// Only main sessions (not subagents) block the chat
		isBusy: (chatId) => {
			const session = sessions.get(chatId)
			return session !== undefined && !session.isSubagent
		},
		enqueue: (chatId, msg) => {
			const queue = messageQueue.get(chatId) || []
			queue.push(msg)
			messageQueue.set(chatId, queue)
		},
		dequeue: (chatId) => {
			const queue = messageQueue.get(chatId)
			if (!queue || queue.length === 0) return undefined
			const msg = queue.shift()
			if (queue.length === 0) messageQueue.delete(chatId)
			return msg
		},
		getQueueLength: (chatId) => messageQueue.get(chatId)?.length ?? 0,
	}
}
