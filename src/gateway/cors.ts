import type { IncomingMessage, ServerResponse } from 'node:http'

const isLocalHost = (host: string) =>
	host === 'localhost' || host === '127.0.0.1'

const isTailscaleHost = (host: string) => host.endsWith('.ts.net')

const isTailscaleIp = (host: string) => {
	const parts = host.split('.').map((part) => Number(part))
	if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false
	if (parts[0] !== 100) return false
	return parts[1] >= 64 && parts[1] <= 127
}

export const isAllowedOrigin = (origin: string) => {
	try {
		const parsed = new URL(origin)
		const host = parsed.hostname
		return isLocalHost(host) || isTailscaleHost(host) || isTailscaleIp(host)
	} catch {
		return false
	}
}

export const applyCorsHeaders = (req: IncomingMessage, res: ServerResponse) => {
	const origin = req.headers.origin
	if (!origin || !isAllowedOrigin(origin)) return
	res.setHeader('access-control-allow-origin', origin)
	res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
	res.setHeader('access-control-allow-headers', 'Authorization,Content-Type')
	res.setHeader('access-control-max-age', '86400')
	res.setHeader('vary', 'Origin')
}
