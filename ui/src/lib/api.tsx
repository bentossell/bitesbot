const BASE_URL = 'http://127.0.0.1:8787'

const authHeaders = (): Record<string, string> => {
	const headers: Record<string, string> = {}
	const token = localStorage.getItem('bitesbot.authToken')
	if (token) headers.Authorization = `Bearer ${token}`
	return headers
}

const request = async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
	const res = await fetch(`${BASE_URL}${path}`, {
		...options,
		headers: {
			'content-type': 'application/json',
			...authHeaders(),
			...(options.headers ?? {}),
		},
	})
	return (await res.json()) as T
}

export const fetchSteps = () => request<{ ok: boolean; steps: unknown[] }>('/wizard/steps')

export const createSession = (data: unknown) =>
	request<{ ok: boolean; session: unknown }>('/wizard/session', {
		method: 'POST',
		body: JSON.stringify({ data }),
	})

export const updateSession = (sessionId: string, data: unknown) =>
	request<{ ok: boolean; session: unknown }>(`/wizard/session/${sessionId}`, {
		method: 'POST',
		body: JSON.stringify({ data }),
	})

export const nextSessionStep = (sessionId: string) =>
	request<{ ok: boolean; session: unknown }>(`/wizard/session/${sessionId}/next`, { method: 'POST' })

export const prevSessionStep = (sessionId: string) =>
	request<{ ok: boolean; session: unknown }>(`/wizard/session/${sessionId}/prev`, { method: 'POST' })

export const detectChatId = () => request<{ ok: boolean; chatId?: number }>('/wizard/chat-id')

export const testConnection = (botToken: string, chatId?: string) =>
	request<{ ok: boolean; bot?: { id: number; username?: string; firstName?: string }; error?: string }>(
		'/wizard/test',
		{
			method: 'POST',
			body: JSON.stringify({ botToken, chatId }),
		},
	)

export const bootstrap = (payload: Record<string, unknown>) =>
	request<{ ok: boolean; workspace?: unknown; config?: unknown; cron?: unknown; error?: string }>(
		'/wizard/bootstrap',
		{
			method: 'POST',
			body: JSON.stringify(payload),
		},
	)
