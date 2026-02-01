import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface, type Interface } from 'node:readline'
import type { CLIManifest } from './manifest.js'
import { loadEnvFile } from './env-file.js'
import { log, logError } from '../logging/file.js'

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

// Codex CLI events
export type CodexEvent =
	| { type: 'thread.started'; thread_id: string }
	| { type: 'turn.started' }
	| { type: 'item.completed'; item: { id: string; type: string; text?: string } }
	| { type: 'turn.completed'; usage?: { input_tokens?: number; output_tokens?: number } }

export type PiMessage = {
	role?: string
	content?: Array<{ type?: string; text?: string }>
}

export type PiAssistantMessageEvent =
	| { type: 'text_delta'; delta: string }
	| { type: string; [key: string]: unknown }

export type PiEvent =
	| { type: 'session'; id: string; version?: number; timestamp?: string; cwd?: string }
	| { type: 'agent_start' }
	| { type: 'agent_end'; messages?: PiMessage[] }
	| { type: 'turn_start' }
	| { type: 'turn_end'; message: PiMessage; toolResults?: unknown[] }
	| { type: 'message_start'; message: PiMessage }
	| { type: 'message_update'; message: PiMessage; assistantMessageEvent?: PiAssistantMessageEvent }
	| { type: 'message_end'; message: PiMessage }
	| { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult?: unknown }
	| { type: 'tool_execution_end'; toolCallId: string; toolName: string; result?: unknown; isError: boolean }

export type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content?: string | unknown[]; is_error?: boolean }
	| { type: 'thinking'; thinking: string }

type JsonlEvent = ClaudeEvent | DroidEvent | CodexEvent | PiEvent

export type BridgeEvent =
	| { type: 'started'; sessionId: string; model?: string }
	| { type: 'tool_start'; toolId: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_end'; toolId: string; isError: boolean; preview?: string }
	| { type: 'thinking'; text: string }
	| { type: 'text'; text: string }
	| { type: 'completed'; sessionId: string; answer: string; isError: boolean; cost?: number }
	| { type: 'error'; message: string }

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

export type ToolExecutorResult = {
	result?: unknown
	isError?: boolean
	error?: string
}

export type ToolExecutor = (call: {
	toolCallId: string
	toolName: string
	args: Record<string, unknown>
}) => Promise<ToolExecutorResult>

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
		options?: { isSubagent?: boolean; envFile?: string; toolExecutor?: ToolExecutor }
	) {
		super()
		this.id = `${chatId}-${Date.now()}`
		this.chatId = chatId
		this.cli = manifest.name
		this.isSubagent = options?.isSubagent ?? false
		this.envFile = options?.envFile
		this.toolExecutor = options?.toolExecutor
	}

	private envFile?: string
	private toolExecutor?: ToolExecutor

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

	run(
		prompt: string,
		resume?: ResumeToken,
		options?: { model?: string }
	): void {
		if (this.process) {
			log(`[jsonl-session] Process already running for ${this.chatId}`)
			return
		}

		const appendResumeArgs = (args: string[]) => {
			if (!resume?.sessionId) return
			const flag = this.manifest.resume?.flag ?? (this.cli === 'droid' ? '-s' : '--resume')
			args.push(flag, resume.sessionId)
		}
		const appendWorkingDirArgs = (args: string[]) => {
			if (!this.manifest.workingDirFlag) return
			args.push(this.manifest.workingDirFlag, this.workingDir)
		}
		const appendModelArgs = (args: string[]) => {
			const modelConfig = this.manifest.model
			if (!modelConfig?.flag) return
			const modelId = options?.model ?? modelConfig.default
			if (!modelId) return
			args.push(modelConfig.flag, modelId)
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
			appendWorkingDirArgs(args)
			appendModelArgs(args)
			args.push(prompt)
		} else if (this.cli === 'codex') {
			// Codex uses: codex exec --json --dangerously-bypass-approvals-and-sandbox "prompt"
			const baseArgs = this.manifest.args
			const hasExec = baseArgs[0] === 'exec'
			const resumeId = resume?.sessionId
			const isResume = Boolean(resumeId)
			args = hasExec ? [...baseArgs] : ['exec', ...baseArgs]
			if (isResume && !args.includes('resume')) {
				const execIndex = args.indexOf('exec')
				const insertAt = execIndex === -1 ? 0 : execIndex + 1
				args.splice(insertAt, 0, 'resume')
			}
			if (!isResume) {
				appendWorkingDirArgs(args)
			}
			appendModelArgs(args)
			if (resumeId) {
				args.push(resumeId)
			}
			args.push(prompt)
		} else if (this.cli === 'pi') {
			// Pi uses: pi --mode json "prompt"
			args = [...this.manifest.args]
			appendResumeArgs(args)
			appendWorkingDirArgs(args)
			appendModelArgs(args)
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
			appendWorkingDirArgs(args)
			appendModelArgs(args)
			args.push(prompt)
		}

		log(`[jsonl-session] Spawning: ${this.manifest.command} ${args.slice(0, -1).join(' ')} "<prompt>"`)
		log(`[jsonl-session] Working dir: ${this.workingDir}`)

		this.process = spawn(this.manifest.command, args, {
			cwd: this.workingDir,
			env: loadEnvFile(this.envFile),
			stdio: ['pipe', 'pipe', 'pipe'],
		})

		// Close stdin to signal we're done sending input (keep open for Pi tool results)
		if (!(this.cli === 'pi' && this.toolExecutor)) {
			this.process.stdin?.end()
		}

		this._state = 'active'
		this._lastActivity = new Date()

		this.readline = createInterface({ input: this.process.stdout! })
		this.readline.on('line', (line) => this.handleLine(line))

		this.process.stderr?.on('data', (data) => {
			const text = data.toString().trim()
			if (text) {
				log(`[jsonl-session] stderr: ${text}`)
			}
		})

		this.process.on('exit', (code) => {
			log(`[jsonl-session] Process exited with code ${code}`)
			this._state = 'completed'
			this.process = null
			this.readline = null
			this.emit('exit', code ?? 0)
		})

		this.process.on('error', (err) => {
			logError(`[jsonl-session] Process error:`, err)
			this.emit('event', { type: 'error', message: err.message })
		})
	}

	private handleLine(line: string): void {
		this._lastActivity = new Date()

		if (!line.trim()) return

		try {
			const event = JSON.parse(line) as JsonlEvent
			this.translateEvent(event)
		} catch {
			log(`[jsonl-session] Non-JSON line: ${line.slice(0, 100)}`)
		}
	}

	private async handlePiToolExecution(event: Extract<PiEvent, { type: 'tool_execution_start' }>): Promise<void> {
		if (!this.toolExecutor) return
		if (!this.process?.stdin || !this.process.stdin.writable) {
			log(`[pi-session] Tool executor unavailable (stdin closed) tool=${event.toolName} id=${event.toolCallId}`)
			return
		}
		log(`[pi-session] Executing tool=${event.toolName} id=${event.toolCallId}`)
		try {
			const result = await this.toolExecutor({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args ?? {},
			})
			const payload = {
				type: 'tool_execution_end',
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: result.error ? { error: result.error } : result.result,
				isError: Boolean(result.isError || result.error),
			}
			log(`[pi-session] Tool result id=${event.toolCallId} isError=${payload.isError}`)
			this.process.stdin.write(`${JSON.stringify(payload)}\n`)
		} catch (err) {
			const message = err instanceof Error ? err.message : 'unknown error'
			log(`[pi-session] Tool execution error id=${event.toolCallId} error=${message}`)
			const payload = {
				type: 'tool_execution_end',
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: { error: message },
				isError: true,
			}
			this.process.stdin.write(`${JSON.stringify(payload)}\n`)
		}
	}

	private translateEvent(event: JsonlEvent): void {
		const extractPiText = (message?: PiMessage): string | undefined => {
			if (!message?.content || !Array.isArray(message.content)) return undefined
			const text = message.content
				.filter((block) => block.type === 'text' && typeof block.text === 'string')
				.map((block) => block.text)
				.join('')
			return text || undefined
		}

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

			// Pi: session header
			case 'session':
				if ('id' in event && event.id) {
					this._resumeToken = { engine: this.cli, sessionId: event.id }
					this.emit('event', {
						type: 'started',
						sessionId: event.id,
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

			// Pi: message update with text deltas
			case 'message_start':
				if (event.message?.role === 'assistant') {
					this._lastText = ''
				}
				break

			// Pi: message update with text deltas
			case 'message_update':
				if (event.assistantMessageEvent?.type === 'text_delta' && typeof event.assistantMessageEvent.delta === 'string') {
					this._lastText = `${this._lastText}${event.assistantMessageEvent.delta}`
					this.emit('event', { type: 'text', text: event.assistantMessageEvent.delta })
				}
				break

			// Pi: message end (capture final text if provided)
			case 'message_end':
				if (event.message?.role === 'assistant') {
					const text = extractPiText(event.message)
					if (text) this._lastText = text
				}
				break

			// Pi: tool execution
			case 'tool_execution_start':
				log(`[pi-session] tool_execution_start tool=${event.toolName} id=${event.toolCallId}`)
				this.pendingTools.set(event.toolCallId, { name: event.toolName, input: event.args ?? {} })
				this.emit('event', {
					type: 'tool_start',
					toolId: event.toolCallId,
					name: event.toolName,
					input: event.args ?? {},
				})
				void this.handlePiToolExecution(event)
				break

			case 'tool_execution_end': {
				log(`[pi-session] tool_execution_end id=${event.toolCallId} isError=${event.isError} pendingBefore=${this.pendingTools.size}`)
				this.pendingTools.delete(event.toolCallId)
				const preview =
					typeof event.result === 'string'
						? event.result
						: event.result
							? JSON.stringify(event.result)
							: undefined
				this.emit('event', {
					type: 'tool_end',
					toolId: event.toolCallId,
					isError: !!event.isError,
					preview,
				})
				break
			}

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

			// Codex: thread.started
			case 'thread.started':
				if ('thread_id' in event) {
					this._resumeToken = { engine: this.cli, sessionId: event.thread_id }
					this.emit('event', {
						type: 'started',
						sessionId: event.thread_id,
					})
				}
				break

			// Codex: item.completed (contains text response)
			case 'item.completed':
				if ('item' in event && event.item?.type === 'agent_message' && event.item.text) {
					this._lastText = event.item.text
					this.emit('event', { type: 'text', text: event.item.text })
				}
				break

			// Codex: turn.completed (signals end of turn)
			case 'turn.completed': {
				const sessionId = this._resumeToken?.sessionId || 'unknown'
				this.emit('event', {
					type: 'completed',
					sessionId,
					answer: this._lastText,
					isError: false,
				})
				break
			}

			// Pi: turn end - capture text but don't emit completion (wait for agent_end)
			case 'turn_end': {
				const text = extractPiText(event.message)
				if (text) this._lastText = text
				break
			}
			// Pi: agent end signals the session is complete
			case 'agent_end': {
				const sessionId = this._resumeToken?.sessionId || 'unknown'
				// Extract text from agent_end messages if available and lastText is empty
				if (!this._lastText && event.messages?.length) {
					const lastAssistantMsg = [...event.messages].reverse().find(m => m.role === 'assistant')
					if (lastAssistantMsg) {
						const text = extractPiText(lastAssistantMsg)
						if (text) this._lastText = text
					}
				}
				log(`[pi-session] agent_end emitting completion sessionId=${sessionId} lastText_len=${this._lastText.length}`)
				this.emit('event', {
					type: 'completed',
					sessionId,
					answer: this._lastText || '(no response)',
					isError: false,
				})
				break
			}
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
	context?: {
		source?: 'user' | 'cron' | 'memory-tool' | 'session-tool'
		cronJobId?: string
		memoryToolDepth?: number
		sessionToolDepth?: number
		isPrivateChat?: boolean
	}
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
	clearResumeToken: (chatId: number | string, cli: string) => void
	clearResumeTokens: (chatId: number | string) => void
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
		clearResumeToken: (chatId, cli) => resumeTokens.delete(`${chatId}:${cli}`),
		clearResumeTokens: (chatId) => {
			const prefix = `${chatId}:`
			for (const key of resumeTokens.keys()) {
				if (key.startsWith(prefix)) {
					resumeTokens.delete(key)
				}
			}
		},
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
