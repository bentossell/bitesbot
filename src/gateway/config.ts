import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type BridgeConfig = {
	enabled: boolean
	defaultCli: string
	workingDirectory: string
	adaptersDir: string
}

export type GatewayConfig = {
	botToken: string
	host: string
	port: number
	authToken?: string
	configPath?: string
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

	const fileBridge: Partial<BridgeConfig> = fileConfig.bridge ?? {}
	const bridge: BridgeConfig = {
		enabled: env.TG_GATEWAY_BRIDGE_ENABLED === 'true' || fileBridge.enabled === true,
		defaultCli: env.TG_GATEWAY_DEFAULT_CLI ?? fileBridge.defaultCli ?? 'claude',
		workingDirectory: env.TG_GATEWAY_WORKING_DIR ?? fileBridge.workingDirectory ?? process.cwd(),
		adaptersDir: env.TG_GATEWAY_ADAPTERS_DIR ?? fileBridge.adaptersDir ?? join(process.cwd(), 'adapters'),
	}

	return {
		botToken,
		host,
		port,
		authToken,
		configPath,
		bridge,
	}
}
