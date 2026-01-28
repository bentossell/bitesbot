import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export type SpawnContext = {
	spawnSubagent: (opts: {
		chatId: number | string
		task: string
		label?: string
		cli?: string
	}) => Promise<{ runId: string; status: string }>
	defaultChatId: () => number | string | null
	defaultCli: string
}

export const createSessionsSpawnTool = (): Tool => ({
	name: 'sessions_spawn',
	description:
		'Spawn a background sub-agent to work on a task independently. The sub-agent runs in parallel and announces results when complete. Use this for tasks that can be delegated, like research, file analysis, or independent coding tasks.',
	inputSchema: {
		type: 'object',
		properties: {
			task: {
				type: 'string',
				description: 'The task description for the sub-agent to work on',
			},
			label: {
				type: 'string',
				description: 'Optional friendly name for the sub-agent (shown in status)',
			},
			cli: {
				type: 'string',
				description: 'Which CLI to use (e.g., "droid", "claude"). Defaults to current CLI.',
			},
		},
		required: ['task'],
	},
})

export const executeSessionsSpawn = async (
	args: Record<string, unknown>,
	ctx: SpawnContext
): Promise<CallToolResult> => {
	const task = typeof args.task === 'string' ? args.task.trim() : ''
	const label = typeof args.label === 'string' ? args.label.trim() : undefined
	const cli = typeof args.cli === 'string' ? args.cli.trim() : undefined

	if (!task) {
		return {
			content: [{ type: 'text', text: 'Error: task is required' }],
			isError: true,
		}
	}

	const chatId = ctx.defaultChatId()
	if (!chatId) {
		return {
			content: [{ type: 'text', text: 'Error: no active chat to spawn subagent in' }],
			isError: true,
		}
	}

	try {
		const result = await ctx.spawnSubagent({
			chatId,
			task,
			label,
			cli: cli || ctx.defaultCli,
		})

		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						status: 'accepted',
						runId: result.runId,
						message: `Subagent spawned${label ? ` (${label})` : ''}. It will announce results when complete.`,
					}),
				},
			],
			isError: false,
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : 'unknown error'
		return {
			content: [{ type: 'text', text: `Error spawning subagent: ${message}` }],
			isError: true,
		}
	}
}
