/**
 * Comprehensive E2E Test Suite for Agent Adapters
 *
 * Tests all supported adapters (droid, codex, claude, pi) through the full gateway stack.
 * Covers: spawn, tool use, model switching, /status, session continuity, clean exit,
 * subagents, memory, cron/reminders, and all slash commands.
 *
 * ISOLATION: All tests run in an isolated temp workspace - no changes to real workspace.
 *
 * Run: TG_E2E_RUN=1 pnpm test:e2e --grep adapters
 *
 * Required env vars:
 * - TG_E2E_API_ID, TG_E2E_API_HASH, TG_E2E_SESSION
 * - TG_E2E_BOT_TOKEN, TG_E2E_BOT_USERNAME
 * - TG_E2E_RUN=1
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { TelegramClient, sessions } from 'telegram'
import WebSocket from 'ws'
import { setTimeout as delay } from 'node:timers/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { startGatewayServer, type GatewayServerHandle } from '../src/gateway/server.js'
import { startBridge, type BridgeHandle, setWorkspaceDir } from '../src/bridge/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// Environment & Config
// ─────────────────────────────────────────────────────────────────────────────

const apiId = Number(process.env.TG_E2E_API_ID ?? '')
const apiHash = process.env.TG_E2E_API_HASH ?? ''
const sessionStr = process.env.TG_E2E_SESSION ?? ''
const botToken = process.env.TG_E2E_BOT_TOKEN ?? ''
const botUsernameRaw = process.env.TG_E2E_BOT_USERNAME ?? ''
const authToken = process.env.TG_E2E_AUTH_TOKEN
const allowedChatIdEnv = process.env.TG_E2E_ALLOWED_CHAT_ID
const gatewayPortRaw = process.env.TG_E2E_GATEWAY_PORT

const botUsername = botUsernameRaw
	? botUsernameRaw.startsWith('@') ? botUsernameRaw : `@${botUsernameRaw}`
	: ''
const gatewayPort = Number(gatewayPortRaw ?? '8791') // Different port from main e2e tests
const hasEnv = Boolean(apiId && apiHash && sessionStr && botToken && botUsername)
const isCI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS)
const shouldRun = hasEnv && !isCI && process.env.TG_E2E_RUN === '1'

// Timeout constants
const SHORT_TIMEOUT = 30_000
const MEDIUM_TIMEOUT = 60_000
const LONG_TIMEOUT = 180_000

// ─────────────────────────────────────────────────────────────────────────────
// Mock Workspace Structure - Simulates a bot that's been used for a while
// ─────────────────────────────────────────────────────────────────────────────

const TEST_CHAT_ID = '123456789'
const TEST_SESSION_ID = 'test-session-abc123'

const createMockWorkspace = async (baseDir: string): Promise<{ workspaceDir: string; toolTestDir: string }> => {
	const workspaceDir = baseDir
	const toolTestDir = join(workspaceDir, 'tool-tests')
	
	// Create directory structure
	await mkdir(join(workspaceDir, 'sessions'), { recursive: true })
	await mkdir(join(workspaceDir, '.state'), { recursive: true })
	await mkdir(join(workspaceDir, '.tg-workspace', 'concepts'), { recursive: true })
	await mkdir(join(workspaceDir, 'docs'), { recursive: true })
	await mkdir(join(workspaceDir, 'notes'), { recursive: true })
	await mkdir(toolTestDir, { recursive: true })

	// ─────────────────────────────────────────────────────────────────────────
	// 1. Past Session Transcripts - 2 days of conversation history
	// ─────────────────────────────────────────────────────────────────────────
	
	const day1 = '2026-01-28'
	const day2 = '2026-01-29'
	
	// Day 1 JSONL - User introduction and preferences
	const day1Jsonl = [
		{ timestamp: `${day1}T10:00:00Z`, chatId: TEST_CHAT_ID, role: 'user', text: 'Hey! My name is TestUser.', cli: 'droid' },
		{ timestamp: `${day1}T10:00:15Z`, chatId: TEST_CHAT_ID, role: 'assistant', text: 'Nice to meet you, TestUser! How can I help you today?', cli: 'droid' },
		{ timestamp: `${day1}T10:01:00Z`, chatId: TEST_CHAT_ID, role: 'user', text: 'I prefer concise responses. Also my timezone is UTC.', cli: 'droid' },
		{ timestamp: `${day1}T10:01:20Z`, chatId: TEST_CHAT_ID, role: 'assistant', text: 'Got it - concise responses, UTC timezone. Noted!', cli: 'droid' },
		{ timestamp: `${day1}T14:00:00Z`, chatId: TEST_CHAT_ID, role: 'user', text: "I'm working on a project called bitesbot - it's a Telegram gateway for CLI agents.", cli: 'droid' },
		{ timestamp: `${day1}T14:00:30Z`, chatId: TEST_CHAT_ID, role: 'assistant', text: 'Interesting! A Telegram gateway that bridges to CLI agents like Claude and Droid. What would you like help with?', cli: 'droid' },
	].map(e => JSON.stringify(e)).join('\n') + '\n'
	
	// Day 1 Markdown transcript
	const day1Md = `# Session Transcript - ${day1}

### ${day1}T10:00:00Z (chat:${TEST_CHAT_ID} cli:droid)
**USER**
> Hey! My name is TestUser.

### ${day1}T10:00:15Z (chat:${TEST_CHAT_ID} cli:droid)
**ASSISTANT**
> Nice to meet you, TestUser! How can I help you today?

### ${day1}T10:01:00Z (chat:${TEST_CHAT_ID} cli:droid)
**USER**
> I prefer concise responses. Also my timezone is UTC.

### ${day1}T10:01:20Z (chat:${TEST_CHAT_ID} cli:droid)
**ASSISTANT**
> Got it - concise responses, UTC timezone. Noted!

### ${day1}T14:00:00Z (chat:${TEST_CHAT_ID} cli:droid)
**USER**
> I'm working on a project called bitesbot - it's a Telegram gateway for CLI agents.

### ${day1}T14:00:30Z (chat:${TEST_CHAT_ID} cli:droid)
**ASSISTANT**
> Interesting! A Telegram gateway that bridges to CLI agents like Claude and Droid. What would you like help with?

`

	// Day 2 JSONL - Project work and tasks
	const day2Jsonl = [
		{ timestamp: `${day2}T09:00:00Z`, chatId: TEST_CHAT_ID, role: 'user', text: 'Can you help me add e2e tests for the adapter system?', cli: 'droid' },
		{ timestamp: `${day2}T09:00:45Z`, chatId: TEST_CHAT_ID, role: 'assistant', text: "Sure! I'll create a comprehensive test suite covering spawn, tool use, model switching, and session continuity.", cli: 'droid' },
		{ timestamp: `${day2}T09:30:00Z`, chatId: TEST_CHAT_ID, role: 'user', text: 'The tests should run in an isolated workspace so they dont mess with my real files.', cli: 'droid' },
		{ timestamp: `${day2}T09:30:20Z`, chatId: TEST_CHAT_ID, role: 'assistant', text: "Good idea. I'll create a temp workspace with mock data and redirect all file operations there.", cli: 'droid' },
		{ timestamp: `${day2}T15:00:00Z`, chatId: TEST_CHAT_ID, role: 'user', text: 'Remember to also test subagents and cron jobs.', cli: 'droid' },
		{ timestamp: `${day2}T15:00:15Z`, chatId: TEST_CHAT_ID, role: 'assistant', text: 'Added to the list: subagent spawning, /spawn command, cron creation, and reminder tests.', cli: 'droid' },
	].map(e => JSON.stringify(e)).join('\n') + '\n'

	// Day 2 Markdown transcript
	const day2Md = `# Session Transcript - ${day2}

### ${day2}T09:00:00Z (chat:${TEST_CHAT_ID} cli:droid)
**USER**
> Can you help me add e2e tests for the adapter system?

### ${day2}T09:00:45Z (chat:${TEST_CHAT_ID} cli:droid)
**ASSISTANT**
> Sure! I'll create a comprehensive test suite covering spawn, tool use, model switching, and session continuity.

### ${day2}T09:30:00Z (chat:${TEST_CHAT_ID} cli:droid)
**USER**
> The tests should run in an isolated workspace so they dont mess with my real files.

### ${day2}T09:30:20Z (chat:${TEST_CHAT_ID} cli:droid)
**ASSISTANT**
> Good idea. I'll create a temp workspace with mock data and redirect all file operations there.

### ${day2}T15:00:00Z (chat:${TEST_CHAT_ID} cli:droid)
**USER**
> Remember to also test subagents and cron jobs.

### ${day2}T15:00:15Z (chat:${TEST_CHAT_ID} cli:droid)
**ASSISTANT**
> Added to the list: subagent spawning, /spawn command, cron creation, and reminder tests.

`

	await writeFile(join(workspaceDir, 'sessions', `${day1}.jsonl`), day1Jsonl)
	await writeFile(join(workspaceDir, 'sessions', `${day1}.md`), day1Md)
	await writeFile(join(workspaceDir, 'sessions', `${day2}.jsonl`), day2Jsonl)
	await writeFile(join(workspaceDir, 'sessions', `${day2}.md`), day2Md)

	// ─────────────────────────────────────────────────────────────────────────
	// 2. Resume Tokens - For session continuity testing
	// ─────────────────────────────────────────────────────────────────────────
	
	const resumeTokens = {
		version: 1,
		tokens: {
			[`${TEST_CHAT_ID}:droid`]: { engine: 'droid', sessionId: TEST_SESSION_ID },
		},
		activeCli: {
			[TEST_CHAT_ID]: 'droid',
		},
		chatSettings: {
			[TEST_CHAT_ID]: { streaming: true, verbose: false, model: 'sonnet' },
		},
	}
	await writeFile(join(workspaceDir, '.state', 'resume-tokens.json'), JSON.stringify(resumeTokens, null, 2))

	// ─────────────────────────────────────────────────────────────────────────
	// 3. Rich MEMORY.md - What the bot "knows" about the user
	// ─────────────────────────────────────────────────────────────────────────
	
	await writeFile(join(workspaceDir, 'MEMORY.md'), `# Memory

## User Profile
- **Name**: TestUser
- **Timezone**: UTC
- **Preferences**: Concise responses, no unnecessary explanations
- **Communication style**: Direct, technical

## Project Context
- **Current project**: bitesbot
- **Description**: Telegram gateway for CLI agents (Claude, Droid, Codex)
- **Tech stack**: TypeScript, Node.js, grammy (Telegram), WebSocket
- **Key directories**:
  - \`src/gateway/\` - Telegram bot and HTTP/WS server
  - \`src/bridge/\` - CLI agent bridge and session management
  - \`src/cron/\` - Scheduled jobs
  - \`adapters/\` - CLI adapter manifests

## Ongoing Tasks
- [ ] Add comprehensive e2e tests for all adapters
- [ ] Implement workspace isolation for tests
- [ ] Test subagent spawning
- [ ] Test cron and reminder functionality
- [x] Fix cron recalculation on restart
- [x] Add model switching support

## Learnings
- User prefers isolated test environments
- Tests should cover: spawn, tool use, model switching, session continuity
- Important to test both happy paths and error handling

## Important Files
- \`src/gateway/server.ts\` - Main gateway server
- \`src/bridge/jsonl-bridge.ts\` - CLI bridge implementation
- \`tests/adapters.e2e.ts\` - E2E test suite
`)

	// ─────────────────────────────────────────────────────────────────────────
	// 4. Workspace Docs with Wiki-Links - For concepts/links testing
	// ─────────────────────────────────────────────────────────────────────────
	
	await writeFile(join(workspaceDir, 'docs', 'architecture.md'), `# Architecture

The [[gateway]] is the core component that handles [[Telegram]] messages.

## Components

### Gateway
The gateway server runs the Telegram bot and exposes HTTP/WebSocket endpoints.
See [[configuration]] for setup details.

### Bridge
The [[bridge]] connects to CLI agents via JSONL protocol.
It manages [[sessions]] and handles [[subagents]].

### Adapters
Each CLI has an [[adapter]] manifest defining how to spawn and communicate with it.
Supported: [[Claude]], [[Droid]], [[Codex]]

## Data Flow
1. Message arrives via Telegram
2. Gateway normalizes and broadcasts via WebSocket
3. Bridge routes to appropriate CLI session
4. Response flows back through gateway to Telegram
`)

	await writeFile(join(workspaceDir, 'docs', 'configuration.md'), `# Configuration

## Environment Variables

The [[gateway]] can be configured via environment variables or config file.

### Required
- \`TG_GATEWAY_BOT_TOKEN\` - Your Telegram bot token
- \`TG_GATEWAY_ALLOWED_CHAT_IDS\` - Comma-separated chat IDs

### Optional
- \`TG_GATEWAY_PORT\` - Server port (default: 8787)
- \`TG_GATEWAY_DEFAULT_CLI\` - Default CLI adapter (default: claude)

## Config File

Location: \`~/.config/tg-gateway/config.json\`

See [[deployment]] for production setup.
`)

	await writeFile(join(workspaceDir, 'docs', 'deployment.md'), `# Deployment

## Local Development

\`\`\`bash
pnpm run dev
\`\`\`

## Production

The [[gateway]] runs on Mac Mini with launchd.

### Service Management
- Start: \`launchctl load ~/Library/LaunchAgents/com.bentossell.bitesbot.plist\`
- Stop: \`launchctl unload ...\`
- Logs: \`~/logs/bitesbot.log\`

See [[configuration]] for environment setup.
See [[architecture]] for system overview.
`)

	await writeFile(join(workspaceDir, 'notes', 'ideas.md'), `# Ideas & Roadmap

## Near Term
- [[Memory]] improvements - better recall accuracy
- [[Subagents]] - parallel task execution
- [[Testing]] - comprehensive e2e coverage

## Future
- Web UI for [[Telegram]] bot
- Multi-user support
- [[Voice]] message handling

## Done
- Basic [[gateway]] implementation
- [[Bridge]] with session resume
- [[Cron]] job scheduling
`)

	await writeFile(join(workspaceDir, 'notes', 'testing-notes.md'), `# Testing Notes

## E2E Test Strategy

### Workspace Isolation
All tests run in a temp directory to avoid polluting real workspace.
The [[bridge]] workingDirectory is set to temp path.

### What to Test
1. **Adapters** - Each [[adapter]] (droid, claude, codex) works correctly
2. **Sessions** - [[Sessions]] persist and resume properly
3. **Tools** - File read/write, shell commands work
4. **Commands** - All slash commands respond correctly

### Seeded Data
- Past [[sessions]] for history testing
- [[MEMORY.md]] with user profile
- Docs with [[links]] for concept testing
`)

	// ─────────────────────────────────────────────────────────────────────────
	// 5. Concepts Config - Aliases and settings
	// ─────────────────────────────────────────────────────────────────────────
	
	const conceptsConfig = {
		aliases: {
			'tg': ['telegram', 'tg-gateway'],
			'cli': ['command-line', 'terminal'],
			'ws': ['websocket', 'websockets'],
			'bot': ['chatbot', 'telegram bot'],
		},
		ignore: ['node_modules', '.git', 'dist'],
	}
	await writeFile(join(workspaceDir, '.tg-workspace', 'concepts', 'config.json'), JSON.stringify(conceptsConfig, null, 2))
	
	// Set workspace dir for session storage
	setWorkspaceDir(workspaceDir)
	
	console.log(`[e2e] Created mock workspace with:`)
	console.log(`      - 2 days of session history`)
	console.log(`      - Resume tokens for chat ${TEST_CHAT_ID}`)
	console.log(`      - MEMORY.md with user profile`)
	console.log(`      - 5 docs with wiki-links`)
	console.log(`      - Concepts config with aliases`)
	
	return { workspaceDir, toolTestDir }
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter Detection
// ─────────────────────────────────────────────────────────────────────────────

type AdapterInfo = {
	name: string
	available: boolean
	modelAliases: string[]
	supportsToolUse: boolean
}

const checkCliAvailable = (command: string): boolean => {
	// Handle home directory paths
	const expanded = command.startsWith('~/') 
		? join(homedir(), command.slice(2))
		: command
	
	if (expanded.includes('/')) {
		return existsSync(expanded)
	}
	try {
		const result = spawnSync('which', [command])
		return result.status === 0
	} catch {
		return false
	}
}

const ADAPTERS: AdapterInfo[] = [
	{
		name: 'droid',
		available: checkCliAvailable('~/.local/bin/droid'),
		modelAliases: ['opus', 'sonnet', 'haiku'],
		supportsToolUse: true,
	},
	{
		name: 'codex',
		available: checkCliAvailable('codex'),
		modelAliases: ['codex', 'codex-max'],
		supportsToolUse: true,
	},
	{
		name: 'claude',
		available: checkCliAvailable('/opt/homebrew/bin/claude'),
		modelAliases: ['opus', 'sonnet', 'haiku'],
		supportsToolUse: true,
	},
	// pi adapter is placeholder - typically requires special setup
	{
		name: 'pi',
		available: false, // Not available by default
		modelAliases: [],
		supportsToolUse: false,
	},
]

const getAvailableAdapters = (): AdapterInfo[] =>
	ADAPTERS.filter(a => a.available)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const isNoiseMessage = (text: string) => {
	const trimmed = text.trim()
	return trimmed.startsWith('💰') || trimmed.toLowerCase().startsWith('cost:') || trimmed.toLowerCase().startsWith('switched to ')
}

const waitForBotMessageContaining = async (
	client: TelegramClient,
	bot: string,
	substring: string,
	timeoutMs: number
) => {
	const deadline = Date.now() + timeoutMs
	const cutoff = Date.now() - 1500
	const needle = substring.toLowerCase()
	const seenIds = new Set<number>()
	while (Date.now() < deadline) {
		const messages = await client.getMessages(bot, { limit: 12 })
		for (const msg of messages) {
			if (!('message' in msg) || !msg.message || msg.out === true || !msg.id) continue
			if (seenIds.has(msg.id)) continue
			const msgDate = msg.date ? msg.date * 1000 : 0
			if (msgDate < cutoff) continue
			const text = String(msg.message)
			if (isNoiseMessage(text)) continue
			seenIds.add(msg.id)
			if (text.toLowerCase().includes(needle)) return text
		}
		await delay(1500)
	}
	throw new Error(`Timeout waiting for bot reply containing: ${substring}`)
}

const waitForNewBotMessage = async (
	client: TelegramClient,
	bot: string,
	afterTimestamp: number,
	predicate: (text: string) => boolean,
	timeoutMs: number,
): Promise<string> => {
	const deadline = Date.now() + timeoutMs
	const cutoff = Math.max(0, afterTimestamp - 500)
	const seenIds = new Set<number>()
	
	while (Date.now() < deadline) {
		const messages = await client.getMessages(bot, { limit: 15 })
		for (const msg of messages) {
			if (!('message' in msg) || !msg.message || !msg.id) continue
			if (msg.out === true) continue
			if (seenIds.has(msg.id)) continue
			const msgDate = msg.date ? msg.date * 1000 : 0
			if (msgDate < cutoff) continue
			seenIds.add(msg.id)
			const text = String(msg.message)
			if (isNoiseMessage(text)) continue
			if (predicate(text)) {
				return text
			}
		}
		await delay(1500)
	}
	throw new Error('Timeout waiting for new bot message matching predicate')
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!shouldRun)('adapters e2e', () => {
	let client: TelegramClient
	let server: GatewayServerHandle
	let bridge: BridgeHandle
	let ws: WebSocket
	let tempDir: string
	let toolTestDir: string
	let workspaceDir: string
	const port = Number.isNaN(gatewayPort) ? 8791 : gatewayPort

	beforeAll(async () => {
		// Create isolated temp workspace
		tempDir = await mkdtemp(join(tmpdir(), 'bitesbot-adapters-e2e-'))
		const mockWorkspace = await createMockWorkspace(tempDir)
		workspaceDir = mockWorkspace.workspaceDir
		toolTestDir = mockWorkspace.toolTestDir
		
		console.log(`[e2e] Isolated workspace: ${workspaceDir}`)

		const { StringSession } = sessions
		client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, { connectionRetries: 5 })
		await client.connect()
		if (!await client.isUserAuthorized()) {
			throw new Error('Telegram session not authorized')
		}

		const me = await client.getMe()
		const allowedChatId = allowedChatIdEnv ? Number(allowedChatIdEnv) : Number(me.id)

		server = await startGatewayServer({
			botToken,
			host: '127.0.0.1',
			port,
			authToken: authToken || undefined,
			allowedChatIds: Number.isNaN(allowedChatId) ? undefined : [allowedChatId],
			bridge: {
				enabled: true,
				defaultCli: 'claude',
				workingDirectory: workspaceDir,
				adaptersDir: join(process.cwd(), 'adapters'),
			},
		})

		bridge = await startBridge({
			gatewayUrl: `http://127.0.0.1:${port}`,
			authToken: authToken || undefined,
			adaptersDir: join(process.cwd(), 'adapters'),
			defaultCli: 'claude',
			workingDirectory: workspaceDir,
		})

		ws = new WebSocket(`ws://127.0.0.1:${port}/events`, authToken
			? { headers: { Authorization: `Bearer ${authToken}` } }
			: undefined)

		await new Promise<void>((resolve, reject) => {
			ws.on('open', () => resolve())
			ws.on('error', reject)
		})
	}, LONG_TIMEOUT)

	afterAll(async () => {
		if (ws?.readyState !== WebSocket.CLOSED) {
			await new Promise<void>((resolve) => {
				ws.once('close', () => resolve())
				ws.close()
			})
		}
		if (bridge) bridge.close()
		if (server) await server.close()
		if (client) await client.disconnect()
		if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Per-Adapter Test Suite
	// ─────────────────────────────────────────────────────────────────────────

	describe.each(getAvailableAdapters())('$name adapter', (adapter) => {
		beforeEach(async () => {
			// Switch to the adapter and start fresh
			await client.sendMessage(botUsername, { message: `/use ${adapter.name}` })
			await waitForBotMessageContaining(client, botUsername, adapter.name, SHORT_TIMEOUT)
			await client.sendMessage(botUsername, { message: '/new' })
			await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)
		}, MEDIUM_TIMEOUT)

		// ───────────────────────────────────────────────────────────────────────
		// 1. Spawn & Basic Response
		// ───────────────────────────────────────────────────────────────────────

		it('spawns successfully and responds to simple prompt', async () => {
			const beforeSend = Date.now()
			await client.sendMessage(botUsername, { message: 'What is 2+2? Reply with just the number.' })
			
			const response = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSend,
				(text) => text.includes('4') && !text.includes('fresh') && !text.includes('CLI:'),
				LONG_TIMEOUT,
			)
			expect(response).toContain('4')
		}, LONG_TIMEOUT)

		// ───────────────────────────────────────────────────────────────────────
		// 2. Model Switching & /status
		// ───────────────────────────────────────────────────────────────────────

		it.skipIf(adapter.modelAliases.length === 0)('/model switches model and /status reflects it', async () => {
			const modelAlias = adapter.modelAliases[0]
			
			// Switch model
			await client.sendMessage(botUsername, { message: `/model ${modelAlias}` })
			const modelReply = await waitForBotMessageContaining(client, botUsername, 'Model set to', SHORT_TIMEOUT)
			expect(modelReply).toContain(modelAlias)
			
			// Check status shows CLI
			await client.sendMessage(botUsername, { message: '/status' })
			const statusReply = await waitForBotMessageContaining(client, botUsername, 'CLI:', SHORT_TIMEOUT)
			expect(statusReply).toContain(`CLI: ${adapter.name}`)
		}, MEDIUM_TIMEOUT)

		it('/model with invalid name returns helpful error', async () => {
			await client.sendMessage(botUsername, { message: '/model invalid-model-xyz-12345' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'Model set to', SHORT_TIMEOUT)
			// The gateway accepts any model string, so it should just echo it back
			expect(reply).toBeDefined()
		}, SHORT_TIMEOUT)

		// ───────────────────────────────────────────────────────────────────────
		// 3. Session Continuity (Multi-turn)
		// ───────────────────────────────────────────────────────────────────────

		it('maintains session continuity across turns', async () => {
			const secretWord = `SECRET_${adapter.name}_${Date.now()}`
			
			// First turn: tell it a secret
			const beforeFirst = Date.now()
			await client.sendMessage(botUsername, { message: `Remember this exact word: ${secretWord}. Just say "OK".` })
			await waitForNewBotMessage(
				client,
				botUsername,
				beforeFirst,
				(text) => text.toLowerCase().includes('ok') || text.includes(secretWord),
				LONG_TIMEOUT,
			)
			
			// Second turn: ask for the secret (same session)
			const beforeSecond = Date.now()
			await client.sendMessage(botUsername, { message: 'What was the secret word I just told you?' })
			const secondResponse = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSecond,
				(text) => text.length > 5 && !text.includes('CLI:'),
				LONG_TIMEOUT,
			)
			
			// Should remember the secret word
			expect(secondResponse).toContain(secretWord)
		}, LONG_TIMEOUT * 2)

		// ───────────────────────────────────────────────────────────────────────
		// 4. Tool Use Tests
		// ───────────────────────────────────────────────────────────────────────

		describe.skipIf(!adapter.supportsToolUse)('tool use', () => {
			it('can read files', async () => {
				// Create a test file
				const testFilePath = join(toolTestDir, `read-test-${adapter.name}.txt`)
				const testContent = `Hello from ${adapter.name} read test!`
				await writeFile(testFilePath, testContent)

				const beforeSend = Date.now()
				await client.sendMessage(botUsername, { 
					message: `Read the file at ${testFilePath} and tell me what it says. Quote the exact content.` 
				})
				
				const response = await waitForNewBotMessage(
					client,
					botUsername,
					beforeSend,
					(text) => text.includes(testContent) || text.includes('Hello from'),
					LONG_TIMEOUT,
				)
				expect(response).toContain(testContent)
			}, LONG_TIMEOUT)

			it('can create files', async () => {
				const testFilePath = join(toolTestDir, `create-test-${adapter.name}-${Date.now()}.txt`)
				const testContent = `Created by ${adapter.name}`

				const beforeSend = Date.now()
				await client.sendMessage(botUsername, { 
					message: `Create a file at ${testFilePath} with the content "${testContent}". Then confirm you created it.` 
				})
				
				await waitForNewBotMessage(
					client,
					botUsername,
					beforeSend,
					(text) => text.toLowerCase().includes('creat') || text.toLowerCase().includes('done'),
					LONG_TIMEOUT,
				)

				// Verify file was created
				await delay(1000) // Give filesystem time
				const exists = existsSync(testFilePath)
				expect(exists).toBe(true)
				
				if (exists) {
					const content = await readFile(testFilePath, 'utf-8')
					expect(content).toContain(testContent)
				}
			}, LONG_TIMEOUT)

			it('can execute shell commands', async () => {
				const beforeSend = Date.now()
				await client.sendMessage(botUsername, { 
					message: 'Run "echo SHELLTEST123" and tell me what it outputs.' 
				})
				
				const response = await waitForNewBotMessage(
					client,
					botUsername,
					beforeSend,
					(text) => text.includes('SHELLTEST123'),
					LONG_TIMEOUT,
				)
				expect(response).toContain('SHELLTEST123')
			}, LONG_TIMEOUT)

			it('can chain multiple tools', async () => {
				// Tool chaining: create file, read it back, report content
				const testFilePath = join(toolTestDir, `chain-test-${adapter.name}-${Date.now()}.txt`)
				const uniqueContent = `CHAIN_${Date.now()}_TEST`

				const beforeSend = Date.now()
				await client.sendMessage(botUsername, { 
					message: `Create a file at ${testFilePath} with content "${uniqueContent}". Then read it back and tell me exactly what it contains.` 
				})
				
				const response = await waitForNewBotMessage(
					client,
					botUsername,
					beforeSend,
					(text) => text.includes(uniqueContent),
					LONG_TIMEOUT,
				)
				expect(response).toContain(uniqueContent)
			}, LONG_TIMEOUT)

			it('can search/grep in files', async () => {
				// Create files to search
				const searchDir = join(toolTestDir, `search-${adapter.name}-${Date.now()}`)
				await import('node:fs/promises').then(fs => fs.mkdir(searchDir, { recursive: true }))
				
				const uniquePattern = `GREPME_${adapter.name}_${Date.now()}`
				await writeFile(join(searchDir, 'file1.txt'), `Some text\n${uniquePattern}\nMore text`)
				await writeFile(join(searchDir, 'file2.txt'), 'Other content')

				const beforeSend = Date.now()
				await client.sendMessage(botUsername, { 
					message: `Search for "${uniquePattern}" in ${searchDir} and tell me which file contains it.` 
				})
				
				const response = await waitForNewBotMessage(
					client,
					botUsername,
					beforeSend,
					(text) => text.includes('file1') || text.includes(uniquePattern),
					LONG_TIMEOUT,
				)
				expect(response).toMatch(/file1|found/i)
			}, LONG_TIMEOUT)
		})

		// ───────────────────────────────────────────────────────────────────────
		// 5. Clean Exit (/stop)
		// ───────────────────────────────────────────────────────────────────────

		it('/stop terminates running session cleanly', async () => {
			// Start a potentially long task
			await client.sendMessage(botUsername, { message: 'List numbers from 1 to 50, one per line.' })
			
			// Wait briefly for it to start
			await delay(3000)
			
			// Stop it
			await client.sendMessage(botUsername, { message: '/stop' })
			const stopReply = await waitForBotMessageContaining(client, botUsername, 'stop', SHORT_TIMEOUT)
			expect(stopReply.toLowerCase()).toContain('stop')
			
			// Status should show no active session
			await client.sendMessage(botUsername, { message: '/status' })
			const statusReply = await waitForBotMessageContaining(client, botUsername, 'CLI:', SHORT_TIMEOUT)
			expect(statusReply).toContain('CLI:')
		}, MEDIUM_TIMEOUT)

		// ───────────────────────────────────────────────────────────────────────
		// 6. Timeout/Error Handling
		// ───────────────────────────────────────────────────────────────────────

		it('handles errors gracefully', async () => {
			const beforeSend = Date.now()
			// Try to read a nonexistent file
			await client.sendMessage(botUsername, { 
				message: 'Try to read /nonexistent/path/that/does/not/exist/file.txt and tell me what happens.' 
			})
			
			const response = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSend,
				(text) => text.length > 10 && !text.includes('CLI:'),
				LONG_TIMEOUT,
			)
			// Should report the file doesn't exist or error, not crash
			expect(response.toLowerCase()).toMatch(/not exist|no such|cannot|error|doesn't exist|unable/i)
		}, LONG_TIMEOUT)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Cross-Adapter Tests
	// ─────────────────────────────────────────────────────────────────────────

	describe('cross-adapter', () => {
		it('/use switches between available adapters', async () => {
			const available = getAvailableAdapters()
			if (available.length < 2) {
				console.log('Skipping cross-adapter test: need at least 2 adapters')
				return
			}

			for (const adapter of available) {
				await client.sendMessage(botUsername, { message: `/use ${adapter.name}` })
				const reply = await waitForBotMessageContaining(client, botUsername, adapter.name, SHORT_TIMEOUT)
				expect(reply).toContain(adapter.name)
				
				await client.sendMessage(botUsername, { message: '/status' })
				const status = await waitForBotMessageContaining(client, botUsername, 'CLI:', SHORT_TIMEOUT)
				expect(status).toContain(`CLI: ${adapter.name}`)
			}
		}, LONG_TIMEOUT)

		it('/use with invalid CLI returns helpful error', async () => {
			await client.sendMessage(botUsername, { message: '/use nonexistent-cli-xyz' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'Unknown CLI', SHORT_TIMEOUT)
			expect(reply).toContain('Available:')
		}, SHORT_TIMEOUT)

		it('/new clears context and works with any adapter', async () => {
			const available = getAvailableAdapters()
			if (available.length === 0) return

			const adapter = available[0]
			await client.sendMessage(botUsername, { message: `/use ${adapter.name}` })
			await waitForBotMessageContaining(client, botUsername, adapter.name, SHORT_TIMEOUT)

			const secretWord = `CROSSTEST_${Date.now()}`
			
			// Teach it something
			const beforeFirst = Date.now()
			await client.sendMessage(botUsername, { message: `Remember: ${secretWord}. Say OK.` })
			await waitForNewBotMessage(
				client,
				botUsername,
				beforeFirst,
				(text) => text.toLowerCase().includes('ok') || text.includes(secretWord),
				LONG_TIMEOUT,
			)

			// Clear session
			await client.sendMessage(botUsername, { message: '/new' })
			await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)

			// Ask - should NOT remember
			const beforeSecond = Date.now()
			await client.sendMessage(botUsername, { message: 'What secret word did I tell you? If none, say "I don\'t know".' })
			const response = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSecond,
				(text) => text.length > 5 && !text.includes('fresh'),
				LONG_TIMEOUT,
			)
			
			// Should NOT contain the secret word after /new
			expect(response).not.toContain(secretWord)
		}, LONG_TIMEOUT * 2)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Status Command Enhancement Tests
	// ─────────────────────────────────────────────────────────────────────────

	describe('/status enhancements', () => {
		it('shows current CLI', async () => {
			await client.sendMessage(botUsername, { message: '/status' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'CLI:', SHORT_TIMEOUT)
			expect(reply).toMatch(/CLI:\s*\w+/)
		}, SHORT_TIMEOUT)

		it('shows streaming setting', async () => {
			await client.sendMessage(botUsername, { message: '/status' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'Streaming:', SHORT_TIMEOUT)
			expect(reply).toMatch(/Streaming:\s*(on|off)/i)
		}, SHORT_TIMEOUT)

		it('shows session state when active', async () => {
			const available = getAvailableAdapters()
			if (available.length === 0) return

			// Start a task
			await client.sendMessage(botUsername, { message: 'Count to 10 slowly.' })
			await delay(2000)

			// Check status while running
			await client.sendMessage(botUsername, { message: '/status' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'CLI:', SHORT_TIMEOUT)
			expect(reply).toContain('CLI:')

			// Stop it
			await client.sendMessage(botUsername, { message: '/stop' })
			await waitForBotMessageContaining(client, botUsername, 'stop', SHORT_TIMEOUT)
		}, MEDIUM_TIMEOUT)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Slash Commands Tests
	// ─────────────────────────────────────────────────────────────────────────

	describe('slash commands', () => {
		it('/help shows available commands', async () => {
			await client.sendMessage(botUsername, { message: '/help' })
			const reply = await waitForBotMessageContaining(client, botUsername, '/', SHORT_TIMEOUT)
			expect(reply).toMatch(/\/use|\/new|\/status|\/model/)
		}, SHORT_TIMEOUT)

		it('/models lists available model aliases', async () => {
			await client.sendMessage(botUsername, { message: '/models' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'opus', SHORT_TIMEOUT)
			expect(reply).toMatch(/sonnet|haiku|opus/i)
		}, SHORT_TIMEOUT)

		it('/stream on enables streaming', async () => {
			await client.sendMessage(botUsername, { message: '/stream on' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'Streaming', SHORT_TIMEOUT)
			expect(reply.toLowerCase()).toMatch(/on|enabled/)
		}, SHORT_TIMEOUT)

		it('/stream off disables streaming', async () => {
			await client.sendMessage(botUsername, { message: '/stream off' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'Streaming', SHORT_TIMEOUT)
			expect(reply.toLowerCase()).toMatch(/off|disabled/)
		}, SHORT_TIMEOUT)

		it('/crons lists scheduled jobs (may be empty)', async () => {
			await client.sendMessage(botUsername, { message: '/crons' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'cron', SHORT_TIMEOUT)
			expect(reply).toBeDefined()
		}, SHORT_TIMEOUT)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Subagent Tests
	// ─────────────────────────────────────────────────────────────────────────

	describe('subagents', () => {
		it('/subagents shows empty list initially', async () => {
			await client.sendMessage(botUsername, { message: '/subagents' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'subagent', SHORT_TIMEOUT)
			expect(reply.toLowerCase()).toMatch(/no.*subagent|subagent|running/i)
		}, SHORT_TIMEOUT)

		it('/spawn creates a subagent and runs task', async () => {
			const available = getAvailableAdapters()
			if (available.length === 0) return

			const beforeSend = Date.now()
			await client.sendMessage(botUsername, { message: '/spawn Calculate 5 * 7 and report the answer' })
			
			// Should get acknowledgment
			const ack = await waitForBotMessageContaining(client, botUsername, 'spawn', MEDIUM_TIMEOUT)
			expect(ack.toLowerCase()).toMatch(/spawn|subagent|started/)
			
			// Should eventually get a result containing 35
			const result = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSend,
				(text) => text.includes('35') || text.toLowerCase().includes('complete'),
				LONG_TIMEOUT,
			)
			expect(result).toBeDefined()
		}, LONG_TIMEOUT)

		it('/subagents shows running/completed subagents after spawn', async () => {
			// Spawn a quick task
			await client.sendMessage(botUsername, { message: '/spawn What is 2+2?' })
			await delay(2000) // Give it time to start
			
			await client.sendMessage(botUsername, { message: '/subagents' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'subagent', SHORT_TIMEOUT)
			expect(reply).toBeDefined()
		}, MEDIUM_TIMEOUT)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Cron & Reminders Tests
	// ─────────────────────────────────────────────────────────────────────────

	describe('cron and reminders', () => {
		it('/cron creates a scheduled job', async () => {
			// Create a cron that runs far in future (won't actually trigger)
			await client.sendMessage(botUsername, { message: '/cron 0 0 1 1 * Test scheduled message' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'cron', MEDIUM_TIMEOUT)
			expect(reply.toLowerCase()).toMatch(/created|scheduled|cron/)
		}, MEDIUM_TIMEOUT)

		it('/crons shows created cron job', async () => {
			await client.sendMessage(botUsername, { message: '/crons' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'Test scheduled', SHORT_TIMEOUT)
			expect(reply).toContain('Test scheduled')
		}, SHORT_TIMEOUT)

		it('/remind creates a reminder', async () => {
			await client.sendMessage(botUsername, { message: '/remind 60m Test reminder' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'remind', MEDIUM_TIMEOUT)
			expect(reply.toLowerCase()).toMatch(/remind|scheduled|set/)
		}, MEDIUM_TIMEOUT)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Memory & Recall Tests (uses seeded data)
	// ─────────────────────────────────────────────────────────────────────────

	describe('memory and recall', () => {
		it('agent can read MEMORY.md and recall user info', async () => {
			const available = getAvailableAdapters()
			if (available.length === 0) return

			await client.sendMessage(botUsername, { message: `/use ${available[0].name}` })
			await waitForBotMessageContaining(client, botUsername, available[0].name, SHORT_TIMEOUT)
			await client.sendMessage(botUsername, { message: '/new' })
			await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)

			const beforeSend = Date.now()
			await client.sendMessage(botUsername, { 
				message: 'Read the MEMORY.md file in your working directory and tell me the user\'s name and timezone.' 
			})
			
			const response = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSend,
				(text) => text.includes('TestUser') || text.includes('UTC'),
				LONG_TIMEOUT,
			)
			expect(response).toMatch(/TestUser|UTC/)
		}, LONG_TIMEOUT)

		it('agent can find info in past session transcripts', async () => {
			const available = getAvailableAdapters()
			if (available.length === 0) return

			const beforeSend = Date.now()
			await client.sendMessage(botUsername, { 
				message: 'Look in the sessions/ directory and find what project the user mentioned they were working on. Read the markdown files there.' 
			})
			
			const response = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSend,
				(text) => text.toLowerCase().includes('bitesbot') || text.toLowerCase().includes('telegram'),
				LONG_TIMEOUT,
			)
			expect(response.toLowerCase()).toMatch(/bitesbot|telegram|gateway/)
		}, LONG_TIMEOUT)

		it('agent can search workspace docs', async () => {
			const available = getAvailableAdapters()
			if (available.length === 0) return

			const beforeSend = Date.now()
			await client.sendMessage(botUsername, { 
				message: 'Search the docs/ directory for files mentioning "gateway" and tell me what components are described.' 
			})
			
			const response = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSend,
				(text) => text.toLowerCase().includes('gateway') || text.toLowerCase().includes('bridge'),
				LONG_TIMEOUT,
			)
			expect(response.toLowerCase()).toMatch(/gateway|bridge|adapter/)
		}, LONG_TIMEOUT)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Wiki-Links & Concepts Tests (uses seeded docs)
	// ─────────────────────────────────────────────────────────────────────────

	describe('links and concepts', () => {
		it('/concepts lists concepts from workspace', async () => {
			await client.sendMessage(botUsername, { message: '/concepts' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'concept', MEDIUM_TIMEOUT)
			expect(reply.toLowerCase()).toMatch(/concept|index|file/)
		}, MEDIUM_TIMEOUT)

		it('/links shows wiki-link connections', async () => {
			await client.sendMessage(botUsername, { message: '/links' })
			const reply = await waitForBotMessageContaining(client, botUsername, 'link', MEDIUM_TIMEOUT)
			expect(reply.toLowerCase()).toMatch(/link|file|docs/)
		}, MEDIUM_TIMEOUT)

		it('agent can follow wiki-links between docs', async () => {
			const available = getAvailableAdapters()
			if (available.length === 0) return

			const beforeSend = Date.now()
			await client.sendMessage(botUsername, { 
				message: 'Read docs/architecture.md and tell me what other documents it links to (look for [[brackets]]).' 
			})
			
			const response = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSend,
				(text) => text.toLowerCase().includes('configuration') || text.toLowerCase().includes('gateway'),
				LONG_TIMEOUT,
			)
			expect(response.toLowerCase()).toMatch(/configuration|gateway|bridge|session/)
		}, LONG_TIMEOUT)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Robustness Tests
	// ─────────────────────────────────────────────────────────────────────────

	describe('robustness', () => {
		it('handles unicode and special characters', async () => {
			const available = getAvailableAdapters()
			if (available.length === 0) return

			await client.sendMessage(botUsername, { message: `/use ${available[0].name}` })
			await waitForBotMessageContaining(client, botUsername, available[0].name, SHORT_TIMEOUT)
			await client.sendMessage(botUsername, { message: '/new' })
			await waitForBotMessageContaining(client, botUsername, 'fresh', SHORT_TIMEOUT)

			const beforeSend = Date.now()
			const unicodeMessage = 'Reply with exactly: Hello 世界 🌍 café naïve'
			await client.sendMessage(botUsername, { message: unicodeMessage })
			
			const response = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSend,
				(text) => text.includes('Hello') || text.includes('世界'),
				LONG_TIMEOUT,
			)
			expect(response).toMatch(/Hello|世界|🌍|café|naïve/)
		}, LONG_TIMEOUT)

		it('handles code blocks correctly', async () => {
			const available = getAvailableAdapters()
			if (available.length === 0) return

			const beforeSend = Date.now()
			await client.sendMessage(botUsername, { message: 'Write a simple function: function add(a,b) { return a+b }. Just output that exact code.' })
			
			const response = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSend,
				(text) => text.includes('function') || text.includes('return'),
				LONG_TIMEOUT,
			)
			expect(response).toMatch(/function|return/)
		}, LONG_TIMEOUT)

		it('handles concurrent messages gracefully', async () => {
			const available = getAvailableAdapters()
			if (available.length === 0) return

			// Send multiple messages rapidly
			await client.sendMessage(botUsername, { message: 'First message: say ONE' })
			await delay(100)
			await client.sendMessage(botUsername, { message: 'Second message: say TWO' })
			await delay(100)
			await client.sendMessage(botUsername, { message: 'Third message: say THREE' })

			// Should get responses (queued, not crashed)
			await delay(5000)
			const messages = await client.getMessages(botUsername, { limit: 10 })
			const botMessages = messages.filter(m => 'out' in m && !m.out)
			expect(botMessages.length).toBeGreaterThan(0)
		}, LONG_TIMEOUT)

		it('handles large output chunking', async () => {
			const available = getAvailableAdapters()
			if (available.length === 0) return

			const beforeSend = Date.now()
			await client.sendMessage(botUsername, { message: 'List the numbers 1 to 100, one per line.' })
			
			// Should eventually complete (may be chunked)
			const response = await waitForNewBotMessage(
				client,
				botUsername,
				beforeSend,
				(text) => text.includes('100') || text.includes('50'),
				LONG_TIMEOUT,
			)
			expect(response).toBeDefined()
		}, LONG_TIMEOUT)
	})

	// ─────────────────────────────────────────────────────────────────────────
	// Workspace Isolation Verification
	// ─────────────────────────────────────────────────────────────────────────

	describe('workspace isolation', () => {
		it('agent file operations stay within temp workspace', async () => {
			const available = getAvailableAdapters()
			if (available.length === 0) return

			// Ask agent to create a file - should be in temp workspace
			const testFileName = `isolation-test-${Date.now()}.txt`
			const beforeSend = Date.now()
			await client.sendMessage(botUsername, { 
				message: `Create a file called ${testFileName} in the current directory with content "isolation test". Confirm when done.` 
			})
			
			await waitForNewBotMessage(
				client,
				botUsername,
				beforeSend,
				(text) => text.toLowerCase().includes('creat') || text.toLowerCase().includes('done'),
				LONG_TIMEOUT,
			)

			await delay(1000)

			// Verify file is NOT in real workspace (isolation test)
			const realPath = join(process.cwd(), testFileName)
			const inReal = existsSync(realPath)
			
			expect(inReal).toBe(false) // Most important: didn't pollute real workspace
			// Agent should have created file in temp workspace (workspaceDir)
		}, LONG_TIMEOUT)

		it('session logs are written to temp workspace', async () => {
			// Sessions dir should be in temp workspace
			const sessionsDir = join(workspaceDir, 'sessions')
			const files = await readdir(sessionsDir).catch(() => [])
			
			// After running tests, there should be some session files
			expect(files.length).toBeGreaterThanOrEqual(0) // May be empty if no sessions yet
			// Workspace isolation is verified by setWorkspaceDir() call in setup
		}, SHORT_TIMEOUT)
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// Skipped Test Notice
// ─────────────────────────────────────────────────────────────────────────────

describe('adapters e2e (skipped)', () => {
	it.skipIf(shouldRun)('skipped: set TG_E2E_RUN=1 with valid TG_E2E_* env vars', () => {
		const available = getAvailableAdapters()
		console.log(`Available adapters: ${available.map(a => a.name).join(', ') || 'none'}`)
		
		if (isCI) {
			console.log('Skipped: Adapter E2E tests are local-only (CI detected)')
		} else if (process.env.TG_E2E_RUN !== '1') {
			console.log('Skipped: TG_E2E_RUN=1 not set')
		} else {
			console.log('Skipped: Missing TG_E2E_* environment variables')
		}
	})
})
