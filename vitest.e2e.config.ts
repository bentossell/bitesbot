import { defineConfig } from 'vitest/config'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const loadEnvFile = (filePath: string) => {
	if (!existsSync(filePath)) return
	const raw = readFileSync(filePath, 'utf-8')
	const lines = raw.split('\n')
	for (const line of lines) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue
		const eq = trimmed.indexOf('=')
		if (eq === -1) continue
		const key = trimmed.slice(0, eq).trim()
		let value = trimmed.slice(eq + 1).trim()
		if (!key) continue
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1)
		}
		if (!Object.hasOwn(process.env, key)) {
			process.env[key] = value
		}
	}
}

loadEnvFile(resolve(process.cwd(), '.env.e2e'))

export default defineConfig({
	test: {
		include: ['tests/**/*.e2e.ts'],
		testTimeout: 60_000,
		hookTimeout: 60_000,
		sequence: {
			concurrent: false,
		},
		poolOptions: {
			threads: {
				minThreads: 1,
				maxThreads: 1,
			},
		},
	},
})
