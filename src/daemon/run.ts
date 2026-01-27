import { loadConfig } from '../gateway/config.js'
import { startGatewayServer } from '../gateway/server.js'
import { startBridge, type BridgeHandle } from '../bridge/index.js'
import { removePidFile, writePidFile } from './pid.js'

export type RunOptions = {
	configPath?: string
	env?: NodeJS.ProcessEnv
}

export const runGateway = async (options: RunOptions = {}) => {
	const config = await loadConfig({ configPath: options.configPath, env: options.env })
	const server = await startGatewayServer(config)
	await writePidFile(process.pid)

	let bridge: BridgeHandle | undefined

	if (config.bridge.enabled) {
		const gatewayUrl = `http://${config.host}:${config.port}`
		bridge = await startBridge({
			gatewayUrl,
			authToken: config.authToken,
			adaptersDir: config.bridge.adaptersDir,
			defaultCli: config.bridge.defaultCli,
			workingDirectory: config.bridge.workingDirectory,
		})
		console.log('Bridge enabled, default CLI:', config.bridge.defaultCli)
	}

	const shutdown = async () => {
		bridge?.close()
		await server.close()
		await removePidFile().catch(() => undefined)
		process.exit(0)
	}

	process.on('SIGTERM', shutdown)
	process.on('SIGINT', shutdown)

	return server
}
