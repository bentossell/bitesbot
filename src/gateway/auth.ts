import type { IncomingMessage } from 'node:http'
import type { GatewayConfig } from './config.js'

export const isAuthorized = (req: IncomingMessage, config: GatewayConfig) => {
	if (!config.authToken) return true
	const header = req.headers.authorization
	if (!header) return false
	const [scheme, token] = header.split(' ')
	return scheme === 'Bearer' && token === config.authToken
}
