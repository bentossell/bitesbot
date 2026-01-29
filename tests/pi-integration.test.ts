import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { loadManifest } from '../src/bridge/manifest.js'
import { resolveModelAlias } from '../src/bridge/jsonl-bridge.js'

describe('Pi Integration', () => {
	it('loads the pi adapter manifest', async () => {
		const manifestPath = join(process.cwd(), 'adapters', 'pi.yaml')
		const manifest = await loadManifest(manifestPath)

		expect(manifest.name).toBe('pi')
		expect(manifest.command).toBe('pi')
		expect(manifest.args).toEqual([])
		expect(manifest.inputMode).toBe('jsonl')
		expect(manifest.resume).toEqual({ flag: '--session', sessionArg: 'last' })
		expect(manifest.model).toEqual({ flag: '--model', default: 'claude-sonnet-4-5-20250929' })
	})

	it('resolves pi model aliases', () => {
		expect(resolveModelAlias('pi')).toBe('claude-sonnet-4-5-20250929')
		expect(resolveModelAlias('pi-opus')).toBe('claude-opus-4-5-20251101')
		expect(resolveModelAlias('pi-haiku')).toBe('claude-haiku-4-5-20251001')
	})

	it('aligns pi aliases with claude aliases', () => {
		expect(resolveModelAlias('pi')).toBe(resolveModelAlias('sonnet'))
		expect(resolveModelAlias('pi-opus')).toBe(resolveModelAlias('opus'))
		expect(resolveModelAlias('pi-haiku')).toBe(resolveModelAlias('haiku'))
	})

	it('passes through unknown aliases', () => {
		expect(resolveModelAlias('some-new-model')).toBe('some-new-model')
	})
})
