import { loadConfig } from '../gateway/config.js'
import { startGatewayServer } from '../gateway/server.js'
import { startBridge, type BridgeHandle, setWorkspaceDir } from '../bridge/index.js'
import { createMcpServer, type McpServerHandle } from '../mcp/index.js'
import { removePidFile, writePidFile } from './pid.js'

export type RunOptions = {
	configPath?: string
	env?: NodeJS.ProcessEnv
	notifyRestart?: boolean
}

export const runGateway = async (options: RunOptions = {}) => {
	const config = await loadConfig({ configPath: options.configPath, env: options.env })
	
	let bridge: BridgeHandle | undefined
	let mcpServer: McpServerHandle | undefined

	if (config.bridge.enabled) {
		// Set workspace directory for session storage
		setWorkspaceDir(config.bridge.workingDirectory)
		
		const gatewayUrl = `http://${config.host}:${config.port}`
		bridge = await startBridge({
			gatewayUrl,
			authToken: config.authToken,
			adaptersDir: config.bridge.adaptersDir,
			defaultCli: config.bridge.defaultCli,
			workingDirectory: config.bridge.workingDirectory,
		})
		console.log('Bridge enabled, default CLI:', config.bridge.defaultCli)

		// Create MCP server with bridge context
		mcpServer = createMcpServer({
			spawnSubagent: bridge.spawnSubagentForMcp,
			defaultChatId: bridge.getPrimaryChatId,
			defaultCli: bridge.getDefaultCli(),
		})
		console.log('MCP server enabled')
	}

	const server = await startGatewayServer(config, { mcpServer })
	await writePidFile(process.pid)

	// Notify users about gateway restart
	if (options.notifyRestart !== false) {
		await server.notifyRestart().catch(() => {})
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
