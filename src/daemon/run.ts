import { loadConfig } from '../gateway/config.js'
import { startGatewayServer } from '../gateway/server.js'
import { removePidFile, writePidFile } from './pid.js'

export type RunOptions = {
	configPath?: string
	env?: NodeJS.ProcessEnv
}

export const runGateway = async (options: RunOptions = {}) => {
	const config = await loadConfig({ configPath: options.configPath, env: options.env })
	const server = await startGatewayServer(config)
	await writePidFile(process.pid)

	const shutdown = async () => {
		await server.close()
		await removePidFile().catch(() => undefined)
		process.exit(0)
	}

	process.on('SIGTERM', shutdown)
	process.on('SIGINT', shutdown)

	return server
}
