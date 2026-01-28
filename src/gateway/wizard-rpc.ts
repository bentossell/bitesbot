import type { IncomingMessage, ServerResponse } from 'node:http'
import { wizardSteps, type WizardStepId } from '../wizard/steps.js'
import { WizardSession, type WizardData } from '../wizard/session.js'
import { applyWizardDefaults, testTelegramConnection } from '../wizard/runner.js'
import {
	bootstrapWorkspace,
	writeGatewayConfig,
	writeHeartbeatCronStore,
	type GatewayConfigInput,
} from '../wizard/bootstrap.js'

export type WizardRpcContext = {
	getLastActiveChatId: () => number | undefined
}

type WizardSessionUpdate = {
	data?: WizardData
	stepId?: WizardStepId
}

type WizardSessionCreate = {
	data?: WizardData
	stepId?: WizardStepId
}

type WizardTestRequest = {
	botToken?: string
	chatId?: string
}

type WizardBootstrapRequest = WizardData & {
	port?: number
	host?: string
	authToken?: string
}

const readBody = async (req: IncomingMessage): Promise<string> => {
	const chunks: Buffer[] = []
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf-8')
}

const sendJson = (res: ServerResponse, status: number, payload: unknown) => {
	res.writeHead(status, { 'content-type': 'application/json' })
	res.end(JSON.stringify(payload))
}

const parseJson = async <T>(req: IncomingMessage): Promise<T> => {
	const raw = await readBody(req)
	if (!raw) return {} as T
	return JSON.parse(raw) as T
}

class WizardSessionStore {
	private sessions = new Map<string, WizardSession>()

	create(input?: WizardSessionCreate): WizardSession {
		const defaults = applyWizardDefaults(input?.data ?? {})
		const session = new WizardSession({ data: defaults, stepId: input?.stepId })
		this.sessions.set(session.id, session)
		return session
	}

	get(id: string): WizardSession | undefined {
		return this.sessions.get(id)
	}
}

const resolveDefaultCli = (data: WizardData): string => {
	if (data.agentType === 'custom' && data.customAdapterName) return data.customAdapterName
	return data.agentType ?? 'claude'
}

export const createWizardRpc = (context: WizardRpcContext) => {
	const store = new WizardSessionStore()

	return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
		const url = new URL(req.url ?? '/', 'http://localhost')
		const segments = url.pathname.split('/').filter(Boolean)
		if (segments[0] !== 'wizard') return false

		const method = req.method ?? 'GET'
		const sub = segments.slice(1)

		if (method === 'GET' && sub.length === 1 && sub[0] === 'steps') {
			sendJson(res, 200, { ok: true, steps: wizardSteps })
			return true
		}

		if (method === 'GET' && sub.length === 1 && sub[0] === 'chat-id') {
			sendJson(res, 200, { ok: true, chatId: context.getLastActiveChatId() })
			return true
		}

		if (sub[0] === 'session') {
			if (method === 'POST' && sub.length === 1) {
				try {
					const body = await parseJson<WizardSessionCreate>(req)
					const session = store.create(body)
					sendJson(res, 200, { ok: true, session: session.snapshot() })
				} catch (error) {
					const message = error instanceof Error ? error.message : 'invalid json'
					sendJson(res, 400, { ok: false, error: message })
				}
				return true
			}

			if (sub.length >= 2) {
				const sessionId = sub[1]
				const session = store.get(sessionId)
				if (!session) {
					sendJson(res, 404, { ok: false, error: 'session not found' })
					return true
				}

				if (method === 'GET' && sub.length === 2) {
					sendJson(res, 200, { ok: true, session: session.snapshot() })
					return true
				}

				if (method === 'POST' && sub.length === 2) {
					try {
						const body = await parseJson<WizardSessionUpdate>(req)
					if (body.data) session.update(body.data)
					if (body.stepId) session.setStep(body.stepId)
						sendJson(res, 200, { ok: true, session: session.snapshot() })
					} catch (error) {
						const message = error instanceof Error ? error.message : 'invalid json'
						sendJson(res, 400, { ok: false, error: message })
					}
					return true
				}

				if (method === 'POST' && sub.length === 3 && sub[2] === 'next') {
					session.next()
					sendJson(res, 200, { ok: true, session: session.snapshot() })
					return true
				}

				if (method === 'POST' && sub.length === 3 && sub[2] === 'prev') {
					session.prev()
					sendJson(res, 200, { ok: true, session: session.snapshot() })
					return true
				}
			}
		}

		if (method === 'POST' && sub.length === 1 && sub[0] === 'test') {
			try {
				const body = await parseJson<WizardTestRequest>(req)
				if (!body.botToken) {
					sendJson(res, 400, { ok: false, error: 'botToken is required' })
					return true
				}
				const result = await testTelegramConnection(body.botToken, body.chatId)
				sendJson(res, result.ok ? 200 : 400, result)
			} catch (error) {
				const message = error instanceof Error ? error.message : 'invalid json'
				sendJson(res, 400, { ok: false, error: message })
			}
			return true
		}

		if (method === 'POST' && sub.length === 1 && sub[0] === 'bootstrap') {
			try {
				const body = await parseJson<WizardBootstrapRequest>(req)
				const data = applyWizardDefaults(body)
				if (!data.botToken) {
					sendJson(res, 400, { ok: false, error: 'botToken is required' })
					return true
				}
				if (!data.workspacePath) {
					sendJson(res, 400, { ok: false, error: 'workspacePath is required' })
					return true
				}

				const workspace = await bootstrapWorkspace({
					workspacePath: data.workspacePath,
					userName: data.userName,
					timezone: data.timezone,
					quietHours: data.quietHours,
					heartbeatSchedule: data.heartbeatEnabled ? data.heartbeatCron : undefined,
				})

				const configInput: GatewayConfigInput = {
					botToken: data.botToken,
					chatId: data.chatId,
					port: body.port,
					host: body.host,
					authToken: body.authToken,
					defaultCli: resolveDefaultCli(data),
					workspacePath: workspace.workspacePath,
					adaptersDir: data.customAdaptersDir?.trim() ? data.customAdaptersDir : undefined,
				}
				const config = await writeGatewayConfig(configInput)

				const cron = await writeHeartbeatCronStore({
					enabled: Boolean(data.heartbeatEnabled),
					cronExpr: data.heartbeatCron,
					timezone: data.timezone,
				})

				sendJson(res, 200, { ok: true, workspace, config, cron })
			} catch (error) {
				const message = error instanceof Error ? error.message : 'bootstrap failed'
				sendJson(res, 500, { ok: false, error: message })
			}
			return true
		}

		sendJson(res, 404, { ok: false, error: 'not found' })
		return true
	}
}
