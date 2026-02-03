import type { IncomingMessage } from 'node:http'
import type { GatewayConfig } from './config.js'

export const isAuthorized = (req: IncomingMessage, config: GatewayConfig) => {
	if (!config.authToken) return true
	const header = req.headers.authorization
	let headerOk = false
	if (header) {
		const [scheme, token] = header.split(' ')
		headerOk = scheme === 'Bearer' && token === config.authToken
	}

	const url = new URL(req.url ?? '/', 'http://localhost')
	const queryToken = url.searchParams.get('token')
	const queryOk = queryToken === config.authToken

	return headerOk || queryOk
}
