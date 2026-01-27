import WebSocket from 'ws'
import type {
	GatewayEvent,
	HealthResponse,
	OutboundMessage,
	SendResponse,
	StatusResponse,
} from '../protocol/types.js'

export type GatewayClientOptions = {
	baseUrl: string
	authToken?: string
}

const authHeaders = (authToken?: string): Record<string, string> => {
	const headers: Record<string, string> = {}
	if (authToken) {
		headers.Authorization = `Bearer ${authToken}`
	}
	return headers
}

export const createGatewayClient = (options: GatewayClientOptions) => {
	const baseUrl = options.baseUrl.replace(/\/$/, '')
	const wsUrl = baseUrl.replace(/^http/, 'ws') + '/events'

	const health = async () => {
		const res = await fetch(`${baseUrl}/health`, {
			headers: authHeaders(options.authToken),
		})
		return (await res.json()) as HealthResponse
	}

	const status = async () => {
		const res = await fetch(`${baseUrl}/status`, {
			headers: authHeaders(options.authToken),
		})
		return (await res.json()) as StatusResponse
	}

	const send = async (payload: OutboundMessage) => {
		const res = await fetch(`${baseUrl}/send`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...authHeaders(options.authToken),
			},
			body: JSON.stringify(payload),
		})
		return (await res.json()) as SendResponse
	}

	const typing = async (chatId: number | string) => {
		const res = await fetch(`${baseUrl}/typing`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...authHeaders(options.authToken),
			},
			body: JSON.stringify({ chatId }),
		})
		return (await res.json()) as { ok: boolean; error?: string }
	}

	const connectEvents = (onEvent: (event: GatewayEvent) => void) => {
		const ws = new WebSocket(wsUrl, {
			headers: authHeaders(options.authToken),
		})

		ws.on('message', (data) => {
			try {
				const parsed = JSON.parse(data.toString()) as GatewayEvent
				onEvent(parsed)
			} catch {
				return
			}
		})

		return ws
	}

	return {
		health,
		status,
		send,
		typing,
		connectEvents,
	}
}
