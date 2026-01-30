import { readFileSync } from 'node:fs'

/**
 * Parse a shell-style env file (supports `export KEY=value` and `KEY=value`)
 * Handles quoted values and comments
 */
export const parseEnvFile = (filePath: string): Record<string, string> => {
	const env: Record<string, string> = {}

	let content: string
	try {
		content = readFileSync(filePath, 'utf-8')
	} catch (err) {
		console.warn(`[env-file] Failed to read ${filePath}:`, (err as Error).message)
		return env
	}

	for (const line of content.split('\n')) {
		const trimmed = line.trim()

		// Skip empty lines and comments
		if (!trimmed || trimmed.startsWith('#')) continue

		// Remove 'export ' prefix if present
		const withoutExport = trimmed.startsWith('export ')
			? trimmed.slice(7)
			: trimmed

		// Find the first = sign
		const eqIndex = withoutExport.indexOf('=')
		if (eqIndex === -1) continue

		const key = withoutExport.slice(0, eqIndex).trim()
		let value = withoutExport.slice(eqIndex + 1).trim()

		// Remove surrounding quotes if present
		if ((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1)
		}

		// Only set if key looks valid (alphanumeric + underscore)
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			env[key] = value
		}
	}

	return env
}

let cachedEnv: Record<string, string> | null = null
let cachedEnvFilePath: string | null = null

/**
 * Load env file and cache the result.
 * Returns merged env (process.env + envFile, with envFile taking precedence)
 */
export const loadEnvFile = (filePath?: string): NodeJS.ProcessEnv => {
	if (!filePath) return process.env

	// Return cached if same file
	if (cachedEnvFilePath === filePath && cachedEnv) {
		return { ...process.env, ...cachedEnv }
	}

	cachedEnv = parseEnvFile(filePath)
	cachedEnvFilePath = filePath

	const keyCount = Object.keys(cachedEnv).length
	if (keyCount > 0) {
		console.log(`[env-file] Loaded ${keyCount} env vars from ${filePath}`)
	}

	return { ...process.env, ...cachedEnv }
}
