import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createSessionsSpawnTool, executeSessionsSpawn, type SpawnContext } from './tools.js'

export type McpServerHandle = {
	handleSse: (req: IncomingMessage, res: ServerResponse) => Promise<void>
	handleMessages: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

// Store active transports by session ID
const transports = new Map<string, SSEServerTransport>()

export const createMcpServer = (spawnContext: SpawnContext): McpServerHandle => {
	const createServer = () => {
		const server = new Server(
			{
				name: 'bitesbot',
				version: '1.0.0',
			},
			{
				capabilities: {
					tools: {},
				},
			}
		)

		// List available tools
		server.setRequestHandler(ListToolsRequestSchema, async () => {
			return {
				tools: [createSessionsSpawnTool()],
			}
		})

		// Handle tool calls
		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const { name, arguments: args } = request.params

			if (name === 'sessions_spawn') {
				return executeSessionsSpawn(args as Record<string, unknown>, spawnContext)
			}

			return {
				content: [{ type: 'text', text: `Unknown tool: ${name}` }],
				isError: true,
			}
		})

		return server
	}

	const handleSse = async (req: IncomingMessage, res: ServerResponse) => {
		// Extract session ID from query params
		const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
		const sessionId = url.searchParams.get('sessionId') ?? `session-${Date.now()}`

		console.log(`[mcp] SSE connection started: ${sessionId}`)

		// Create transport for this session
		const transport = new SSEServerTransport('/mcp/messages', res)
		transports.set(sessionId, transport)

		// Create and connect server
		const server = createServer()
		await server.connect(transport)

		// Cleanup on close
		res.on('close', () => {
			console.log(`[mcp] SSE connection closed: ${sessionId}`)
			transports.delete(sessionId)
			void server.close()
		})
	}

	const handleMessages = async (req: IncomingMessage, res: ServerResponse) => {
		// Extract session ID from query params
		const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
		const sessionId = url.searchParams.get('sessionId')

		if (!sessionId) {
			res.writeHead(400, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ error: 'sessionId required' }))
			return
		}

		const transport = transports.get(sessionId)
		if (!transport) {
			res.writeHead(404, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({ error: 'session not found' }))
			return
		}

		// Read body
		const chunks: Buffer[] = []
		for await (const chunk of req) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
		}
		const body = Buffer.concat(chunks).toString('utf-8')

		// Handle the message through the transport
		await transport.handlePostMessage(req, res, body)
	}

	return { handleSse, handleMessages }
}
