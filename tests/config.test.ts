import { writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/gateway/config.js'

describe('loadConfig', () => {
	it('reads env overrides', async () => {
		const config = await loadConfig({
			env: {
				TG_GATEWAY_BOT_TOKEN: 'token',
				TG_GATEWAY_PORT: '9999',
			},
		})

		expect(config.botToken).toBe('token')
		expect(config.port).toBe(9999)
	})

	it('merges config file values', async () => {
		const path = join(tmpdir(), `tg-gateway-config-${Date.now()}.json`)
		await writeFile(
			path,
			JSON.stringify({ botToken: 'file-token', host: '0.0.0.0', port: 7777 }),
			'utf-8',
		)

		const config = await loadConfig({ configPath: path, env: {} })
		expect(config.botToken).toBe('file-token')
		expect(config.host).toBe('0.0.0.0')
		expect(config.port).toBe(7777)

		await rm(path)
	})
})
