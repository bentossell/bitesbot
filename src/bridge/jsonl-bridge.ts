import WebSocket from 'ws'
import type { GatewayEvent, IncomingMessage } from '../protocol/types.js'
import { type CLIManifest, loadAllManifests } from './manifest.js'
import {
	JsonlSession,
	createSessionStore,
	type SessionStore,
	type BridgeEvent,
	type ResumeToken,
} from './jsonl-session.js'

export type BridgeConfig = {
	gatewayUrl: string
	authToken?: string
	adaptersDir: string
	defaultCli: string
	workingDirectory: string
}

export type BridgeHandle = {
	close: () => void
	getManifests: () => Map<string, CLIManifest>
	getSessionStore: () => SessionStore
}

type CommandResult =
	| { handled: false }
	| { handled: true; response: string }

const parseCommand = (
	text: string,
	chatId: number | string,
	manifests: Map<string, CLIManifest>,
	defaultCli: string,
	sessionStore: SessionStore
): CommandResult => {
	const trimmed = text.trim()

	if (trimmed.startsWith('/use ')) {
		const cli = trimmed.slice(5).trim().toLowerCase()
		const manifest = manifests.get(cli)
		if (!manifest) {
			const available = Array.from(manifests.keys()).join(', ')
			return { handled: true, response: `Unknown CLI: ${cli}. Available: ${available}` }
		}
		// Set active CLI directly instead of pending switch
		sessionStore.setActiveCli(chatId, cli)
		return { handled: true, response: `Switched to ${cli}.` }
	}

	if (trimmed === '/new') {
		const session = sessionStore.get(chatId)
		if (session) {
			session.terminate()
			sessionStore.delete(chatId)
		}
		return { handled: true, response: 'Session cleared. Next message starts fresh.' }
	}

	if (trimmed === '/status') {
		const session = sessionStore.get(chatId)
		const currentCli = sessionStore.getActiveCli(chatId) || session?.cli || defaultCli
		const resumeToken = sessionStore.getResumeToken(chatId, currentCli)
		if (!session && !resumeToken) {
			return { handled: true, response: `No active session. CLI: ${currentCli}` }
		}
		const info = session?.getInfo()
		const lines = [
			`CLI: ${currentCli}`,
			`State: ${info?.state || 'ready'}`,
		]
		if (resumeToken) {
			lines.push(`Resume: ${resumeToken.sessionId.slice(0, 8)}...`)
		}
		return { handled: true, response: lines.join('\n') }
	}

	return { handled: false }
}

const sendToGateway = async (
	baseUrl: string,
	authToken: string | undefined,
	chatId: number | string,
	text: string
) => {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (authToken) {
		headers.Authorization = `Bearer ${authToken}`
	}

	const httpUrl = baseUrl.replace(/^ws/, 'http').replace('/events', '')
	try {
		await fetch(`${httpUrl}/send`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ chatId, text }),
		})
	} catch (err) {
		console.error(`[jsonl-bridge] Failed to send message:`, err)
	}
}

const formatToolName = (name: string): string => {
	const icons: Record<string, string> = {
		Read: '📖',
		Write: '✏️',
		Edit: '✏️',
		Execute: '⚡',
		Bash: '⚡',
		Grep: '🔍',
		Glob: '🔍',
		LS: '📁',
		Create: '📝',
		Task: '🤖',
		WebSearch: '🌐',
		FetchUrl: '🌐',
	}
	return `${icons[name] || '🔧'} ${name}`
}

export const startBridge = async (config: BridgeConfig): Promise<BridgeHandle> => {
	const manifests = await loadAllManifests(config.adaptersDir)
	if (manifests.size === 0) {
		console.warn('[jsonl-bridge] No CLI adapters found in', config.adaptersDir)
	}

	const sessionStore = createSessionStore()

	const wsUrl = config.gatewayUrl.replace(/^http/, 'ws')
	const wsEndpoint = wsUrl.endsWith('/events') ? wsUrl : `${wsUrl}/events`

	const headers: Record<string, string> = {}
	if (config.authToken) {
		headers.Authorization = `Bearer ${config.authToken}`
	}

	const ws = new WebSocket(wsEndpoint, { headers })

	const send = (chatId: number | string, text: string) =>
		sendToGateway(config.gatewayUrl, config.authToken, chatId, text)

	const handleMessage = async (message: IncomingMessage) => {
		const { chatId, text } = message
		if (!text) return

		console.log(`[jsonl-bridge] Received from ${chatId}: "${text.slice(0, 50)}..."`)

		const cmdResult = parseCommand(
			text,
			chatId,
			manifests,
			config.defaultCli,
			sessionStore
		)
		if (cmdResult.handled) {
			console.log(`[jsonl-bridge] Command handled: ${text}`)
			await send(chatId, cmdResult.response)
			return
		}

		// Use active CLI for this chat, or default
		const cliName = sessionStore.getActiveCli(chatId) || config.defaultCli
		const manifest = manifests.get(cliName)
		if (!manifest) {
			console.log(`[jsonl-bridge] CLI '${cliName}' not found`)
			await send(chatId, `CLI '${cliName}' not found. Check adapters directory.`)
			return
		}

		// Get existing resume token for this specific CLI
		const resumeToken = sessionStore.getResumeToken(chatId, cliName)

		console.log(`[jsonl-bridge] Starting ${cliName} session for ${chatId}${resumeToken ? ' (resuming)' : ''}`)

		const session = new JsonlSession(chatId, manifest, config.workingDirectory)
		sessionStore.set(session)

		let lastToolStatus: string | null = null

		session.on('event', async (evt: BridgeEvent) => {
			switch (evt.type) {
				case 'started':
					console.log(`[jsonl-bridge] Session started: ${evt.sessionId}`)
					sessionStore.setResumeToken(chatId, cliName, { engine: cliName, sessionId: evt.sessionId })
					await send(chatId, `🤖 ${cliName} is working...`)
					break

				case 'thinking':
					if (evt.text) {
						const preview = evt.text.length > 100 ? evt.text.slice(0, 100) + '...' : evt.text
						await send(chatId, `💭 ${preview}`)
					}
					break

				case 'tool_start':
					const status = formatToolName(evt.name)
					if (status !== lastToolStatus) {
						lastToolStatus = status
						await send(chatId, status)
					}
					break

				case 'tool_end':
					if (evt.isError) {
						await send(chatId, `❌ Tool failed`)
					}
					break

				case 'completed':
					console.log(`[jsonl-bridge] Completed: ${evt.sessionId}`)
					sessionStore.setResumeToken(chatId, cliName, { engine: cliName, sessionId: evt.sessionId })
					if (evt.answer) {
						const chunks = splitMessage(evt.answer)
						for (const chunk of chunks) {
							await send(chatId, chunk)
						}
					}
					if (evt.cost) {
						await send(chatId, `💰 Cost: $${evt.cost.toFixed(4)}`)
					}
					break

				case 'error':
					await send(chatId, `❌ ${evt.message}`)
					break
			}
		})

		session.on('exit', (code) => {
			console.log(`[jsonl-bridge] Session exited with code ${code}`)
			sessionStore.delete(chatId)
		})

		// Run with resume token if we have one
		session.run(text, resumeToken)
	}

	ws.on('message', (data) => {
		try {
			const event = JSON.parse(data.toString()) as GatewayEvent
			if (event.type === 'message.received') {
				void handleMessage(event.payload)
			}
		} catch {
			// ignore
		}
	})

	ws.on('error', (err) => {
		console.error('[jsonl-bridge] WebSocket error:', err.message)
	})

	ws.on('close', () => {
		console.log('[jsonl-bridge] Disconnected from gateway')
	})

	ws.on('open', () => {
		console.log('[jsonl-bridge] Connected to gateway')
	})

	return {
		close: () => {
			ws.close()
			for (const session of sessionStore.sessions.values()) {
				session.terminate()
			}
		},
		getManifests: () => manifests,
		getSessionStore: () => sessionStore,
	}
}

const splitMessage = (text: string, maxLength = 4000): string[] => {
	if (text.length <= maxLength) return [text]

	const chunks: string[] = []
	let remaining = text

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining)
			break
		}

		let splitAt = remaining.lastIndexOf('\n', maxLength)
		if (splitAt === -1 || splitAt < maxLength / 2) {
			splitAt = maxLength
		}

		chunks.push(remaining.slice(0, splitAt))
		remaining = remaining.slice(splitAt).trimStart()
	}

	return chunks
}
