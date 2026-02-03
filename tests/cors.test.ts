import { describe, expect, it } from 'vitest'
import { isAllowedOrigin } from '../src/gateway/cors.js'

describe('gateway cors', () => {
	it('allows localhost origins', () => {
		expect(isAllowedOrigin('http://localhost:3000')).toBe(true)
		expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true)
	})

	it('allows tailscale dns origins', () => {
		expect(isAllowedOrigin('http://bens-mac-mini.taild3a34a.ts.net:3000')).toBe(true)
	})

	it('allows tailscale ip origins', () => {
		expect(isAllowedOrigin('http://100.106.254.46:3000')).toBe(true)
	})

	it('rejects non-tailscale public origins', () => {
		expect(isAllowedOrigin('https://example.com')).toBe(false)
	})
})
