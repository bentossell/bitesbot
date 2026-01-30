import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseEnvFile } from '../src/bridge/env-file.js'

describe('parseEnvFile', () => {
	const testDir = join(tmpdir(), 'env-file-test-' + Date.now())
	const testFile = join(testDir, 'test.env')

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true })
	})

	afterEach(() => {
		try { unlinkSync(testFile) } catch { /* ignore */ }
		try { rmdirSync(testDir) } catch { /* ignore */ }
	})

	it('parses export KEY=value format', () => {
		writeFileSync(testFile, 'export API_KEY=secret123\nexport OTHER=value')
		const env = parseEnvFile(testFile)
		expect(env.API_KEY).toBe('secret123')
		expect(env.OTHER).toBe('value')
	})

	it('parses KEY=value format without export', () => {
		writeFileSync(testFile, 'MY_VAR=hello\nANOTHER=world')
		const env = parseEnvFile(testFile)
		expect(env.MY_VAR).toBe('hello')
		expect(env.ANOTHER).toBe('world')
	})

	it('skips comments and empty lines', () => {
		writeFileSync(testFile, '# This is a comment\n\nexport VALID=yes\n# another comment')
		const env = parseEnvFile(testFile)
		expect(Object.keys(env)).toEqual(['VALID'])
		expect(env.VALID).toBe('yes')
	})

	it('handles quoted values', () => {
		writeFileSync(testFile, 'DOUBLE="with spaces"\nSINGLE=\'also spaces\'')
		const env = parseEnvFile(testFile)
		expect(env.DOUBLE).toBe('with spaces')
		expect(env.SINGLE).toBe('also spaces')
	})

	it('returns empty object for missing file', () => {
		const env = parseEnvFile('/nonexistent/path/file.env')
		expect(env).toEqual({})
	})

	it('handles mixed formats', () => {
		writeFileSync(testFile, `
# API Keys & Secrets
export ANTHROPIC_API_KEY=sk-ant-123
OPENAI_API_KEY="sk-openai-456"
export GEMINI_API_KEY='gemini-key'

# Not a valid line (no =)
INVALID LINE HERE
`)
		const env = parseEnvFile(testFile)
		expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-123')
		expect(env.OPENAI_API_KEY).toBe('sk-openai-456')
		expect(env.GEMINI_API_KEY).toBe('gemini-key')
		expect(Object.keys(env).length).toBe(3)
	})
})
