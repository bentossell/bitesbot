import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import type { MemoryConfig } from '../memory/types.js'

export type BridgeConfig = {
	enabled: boolean
	defaultCli: string
	subagentFallbackCli?: string
	workingDirectory: string
	adaptersDir: string
	memory?: MemoryConfig
	envFile?: string
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
const DEFAULT_WORKSPACE_DIR = join(homedir(), 'bites')
const DEFAULT_MEMORY_MAX_RESULTS = 6
const DEFAULT_MEMORY_MIN_SCORE = 0.35
const DEFAULT_LINKS_MAX_BACKLINKS = 2
const DEFAULT_LINKS_MAX_FORWARD_LINKS = 2

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

const parseBoolean = (value?: string, fallback?: boolean) => {
	if (value === undefined) return fallback
	if (value === 'true' || value === '1') return true
	if (value === 'false' || value === '0') return false
	return fallback
}

const resolveDefaultQmdPath = () => {
	const bunQmd = join(homedir(), '.bun', 'bin', 'qmd')
	try {
		const stat = statSync(bunQmd)
		if (stat.isFile()) return bunQmd
	} catch {
		// ignore
	}
	return 'qmd'
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
	const resolveEnvFilePath = (path?: string): string | undefined => {
		if (!path) return undefined
		if (path.startsWith('~')) return join(homedir(), path.slice(1))
		return path
	}
	const bridge: BridgeConfig = {
		enabled: env.TG_GATEWAY_BRIDGE_ENABLED === 'true' || fileBridge.enabled === true,
		defaultCli: env.TG_GATEWAY_DEFAULT_CLI ?? fileBridge.defaultCli ?? 'claude',
		subagentFallbackCli: env.TG_GATEWAY_SUBAGENT_FALLBACK_CLI ?? fileBridge.subagentFallbackCli,
		workingDirectory: env.TG_GATEWAY_WORKING_DIR ?? fileBridge.workingDirectory ?? DEFAULT_WORKSPACE_DIR,
		adaptersDir: env.TG_GATEWAY_ADAPTERS_DIR ?? fileBridge.adaptersDir ?? join(process.cwd(), 'adapters'),
		envFile: resolveEnvFilePath(env.TG_GATEWAY_ENV_FILE ?? fileBridge.envFile),
	}

	const fileMemory: Partial<MemoryConfig> = (fileBridge.memory ?? {}) as Partial<MemoryConfig>
	const memoryWorkspaceDir =
		env.TG_GATEWAY_MEMORY_DIR ?? fileMemory.workspaceDir ?? bridge.workingDirectory
	const memory: MemoryConfig = {
		enabled: parseBoolean(env.TG_GATEWAY_MEMORY_ENABLED, fileMemory.enabled ?? true) ?? true,
		workspaceDir: memoryWorkspaceDir,
		qmdPath: env.TG_GATEWAY_QMD_PATH ?? fileMemory.qmdPath ?? resolveDefaultQmdPath(),
		qmdCollection: env.TG_GATEWAY_QMD_COLLECTION ?? fileMemory.qmdCollection ?? 'bites',
		qmdIndexPath:
			env.TG_GATEWAY_QMD_INDEX_PATH ??
			fileMemory.qmdIndexPath ??
			join(memoryWorkspaceDir, '.state', 'qmd', 'index.sqlite'),
		maxResults:
			parseNumber(env.TG_GATEWAY_MEMORY_MAX_RESULTS, fileMemory.maxResults ?? DEFAULT_MEMORY_MAX_RESULTS) ??
			DEFAULT_MEMORY_MAX_RESULTS,
		minScore:
			parseNumber(env.TG_GATEWAY_MEMORY_MIN_SCORE, fileMemory.minScore ?? DEFAULT_MEMORY_MIN_SCORE) ??
			DEFAULT_MEMORY_MIN_SCORE,
		links: {
			enabled: parseBoolean(env.TG_GATEWAY_MEMORY_LINKS_ENABLED, fileMemory.links?.enabled ?? true) ?? true,
			maxBacklinks:
				parseNumber(env.TG_GATEWAY_MEMORY_LINKS_MAX_BACKLINKS, fileMemory.links?.maxBacklinks ?? DEFAULT_LINKS_MAX_BACKLINKS) ??
				DEFAULT_LINKS_MAX_BACKLINKS,
			maxForwardLinks:
				parseNumber(env.TG_GATEWAY_MEMORY_LINKS_MAX_FORWARD_LINKS, fileMemory.links?.maxForwardLinks ?? DEFAULT_LINKS_MAX_FORWARD_LINKS) ??
				DEFAULT_LINKS_MAX_FORWARD_LINKS,
			configDir: env.TG_GATEWAY_MEMORY_LINKS_CONFIG_DIR ?? fileMemory.links?.configDir,
		},
	}

	bridge.memory = memory

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
