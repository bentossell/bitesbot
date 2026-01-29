import { loadConfig } from '../gateway/config.js'
import { startGatewayServer } from '../gateway/server.js'
import { startBridge, type BridgeHandle, setWorkspaceDir } from '../bridge/index.js'
import { createMcpServer } from '../mcp/index.js'
import { removePidFile, writePidFile } from './pid.js'

export type RunOptions = {
	configPath?: string
	env?: NodeJS.ProcessEnv
	notifyRestart?: boolean
}

export const runGateway = async (options: RunOptions = {}) => {
	const config = await loadConfig({ configPath: options.configPath, env: options.env })
	
	// Start gateway FIRST (bridge needs to connect to it)
	// MCP is added later after bridge starts
	const server = await startGatewayServer(config)
	await writePidFile(process.pid)

	// Notify users about gateway restart
	if (options.notifyRestart !== false) {
		await server.notifyRestart().catch(() => {})
	}
	
	let bridge: BridgeHandle | undefined

	if (config.bridge.enabled) {
		// Set workspace directory for session storage
		setWorkspaceDir(config.bridge.workingDirectory)
		
		const gatewayUrl = `http://${config.host}:${config.port}`
		bridge = await startBridge({
			gatewayUrl,
			authToken: config.authToken,
			adaptersDir: config.bridge.adaptersDir,
			defaultCli: config.bridge.defaultCli,
			subagentFallbackCli: config.bridge.subagentFallbackCli,
			workingDirectory: config.bridge.workingDirectory,
			allowedChatIds: config.allowedChatIds,
		})
		console.log('Bridge enabled, default CLI:', config.bridge.defaultCli)

		// Create MCP server with bridge context
		const mcpServer = createMcpServer({
			spawnSubagent: bridge.spawnSubagentForMcp,
			defaultChatId: bridge.getPrimaryChatId,
			defaultCli: bridge.getDefaultCli(),
		})
		
		// Add MCP routes to the running server
		server.addMcpServer(mcpServer)
		console.log('MCP server enabled at /mcp/sse')
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
