import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type BridgeConfig = {
	enabled: boolean
	defaultCli: string
	workingDirectory: string
	adaptersDir: string
	memory?: MemoryConfig
}

export type MemoryConfig = {
	enabled: boolean
	qmdBin?: string
	qmdIndex?: string
	qmdCollection?: string
	qmdLimit?: number
	qmdMinScore?: number
	qmdTimeoutMs?: number
	maxSnippetChars?: number
	maxLinks?: number
	maxBacklinks?: number
}

export type GatewayConfig = {
	botToken: string
	host: string
	port: number
	authToken?: string
	configPath?: string
	allowedChatIds?: number[]
	bridge: BridgeConfig
}

export type LoadConfigOptions = {
	configPath?: string
	env?: NodeJS.ProcessEnv
}

const DEFAULT_PORT = 8787

const resolveDefaultConfigPath = () =>
	join(homedir(), '.config', 'tg-gateway', 'config.json')

const parseNumber = (value?: string, fallback?: number) => {
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isNaN(parsed) ? fallback : parsed
}

const parseConfigFile = async (configPath: string) => {
	const raw = await readFile(configPath, 'utf-8')
	return JSON.parse(raw) as Partial<GatewayConfig>
}

export const loadConfig = async (options: LoadConfigOptions = {}): Promise<GatewayConfig> => {
	const env = options.env ?? process.env
	const configPath = options.configPath ?? env.TG_GATEWAY_CONFIG ?? resolveDefaultConfigPath()
	let fileConfig: Partial<GatewayConfig> = {}

	try {
		fileConfig = await parseConfigFile(configPath)
	} catch {
		fileConfig = {}
	}

	const botToken = env.TG_GATEWAY_BOT_TOKEN ?? fileConfig.botToken
	if (!botToken) {
		throw new Error('TG_GATEWAY_BOT_TOKEN is required')
	}

	const host = env.TG_GATEWAY_HOST ?? fileConfig.host ?? '127.0.0.1'
	const port = parseNumber(env.TG_GATEWAY_PORT, fileConfig.port ?? DEFAULT_PORT) ?? DEFAULT_PORT
	const authToken = env.TG_GATEWAY_AUTH_TOKEN ?? fileConfig.authToken

	// Parse allowed chat IDs from env (comma-separated) or config file
	const parseAllowedChatIds = (envValue?: string, fileValue?: number[]): number[] | undefined => {
		if (envValue) {
			return envValue.split(',').map((id) => Number.parseInt(id.trim(), 10)).filter((id) => !Number.isNaN(id))
		}
		return fileValue
	}
	const allowedChatIds = parseAllowedChatIds(env.TG_GATEWAY_ALLOWED_CHAT_IDS, fileConfig.allowedChatIds)

	const fileBridge: Partial<BridgeConfig> = fileConfig.bridge ?? {}
	const fileMemory: Partial<MemoryConfig> = fileBridge.memory ?? {}
	const memoryEnabled = env.TG_GATEWAY_MEMORY_ENABLED
		? env.TG_GATEWAY_MEMORY_ENABLED === 'true'
		: fileMemory.enabled ?? true
	const memory: MemoryConfig = {
		enabled: memoryEnabled,
		qmdBin: env.TG_GATEWAY_QMD_BIN ?? fileMemory.qmdBin,
		qmdIndex: env.TG_GATEWAY_QMD_INDEX ?? fileMemory.qmdIndex,
		qmdCollection: env.TG_GATEWAY_QMD_COLLECTION ?? fileMemory.qmdCollection,
		qmdLimit: parseNumber(env.TG_GATEWAY_QMD_LIMIT, fileMemory.qmdLimit),
		qmdMinScore: parseNumber(env.TG_GATEWAY_QMD_MIN_SCORE, fileMemory.qmdMinScore),
		qmdTimeoutMs: parseNumber(env.TG_GATEWAY_QMD_TIMEOUT_MS, fileMemory.qmdTimeoutMs),
		maxSnippetChars: parseNumber(env.TG_GATEWAY_QMD_SNIPPET_CHARS, fileMemory.maxSnippetChars),
		maxLinks: parseNumber(env.TG_GATEWAY_QMD_MAX_LINKS, fileMemory.maxLinks),
		maxBacklinks: parseNumber(env.TG_GATEWAY_QMD_MAX_BACKLINKS, fileMemory.maxBacklinks),
	}
	const bridge: BridgeConfig = {
		enabled: env.TG_GATEWAY_BRIDGE_ENABLED === 'true' || fileBridge.enabled === true,
		defaultCli: env.TG_GATEWAY_DEFAULT_CLI ?? fileBridge.defaultCli ?? 'claude',
		workingDirectory: env.TG_GATEWAY_WORKING_DIR ?? fileBridge.workingDirectory ?? process.cwd(),
		adaptersDir: env.TG_GATEWAY_ADAPTERS_DIR ?? fileBridge.adaptersDir ?? join(process.cwd(), 'adapters'),
		memory,
	}

	return {
		botToken,
		host,
		port,
		authToken,
		configPath,
		allowedChatIds,
		bridge,
	}
}
