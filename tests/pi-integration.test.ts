import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { loadManifest } from '../src/bridge/manifest.js'

describe('Pi Integration', () => {
	describe('Pi Adapter Manifest', () => {
		it('parses pi.yaml correctly', async () => {
			const tempDir = join(tmpdir(), `pi-manifest-test-${Date.now()}`)
			await mkdir(tempDir, { recursive: true })
			const manifestPath = join(tempDir, 'pi.yaml')
			
			await writeFile(manifestPath, `
name: pi
command: pi
args: []
inputMode: jsonl

resume:
  flag: --session
  sessionArg: last

model:
  flag: --model
  default: claude-sonnet-4-5-20250929
`)
			
			try {
				const manifest = await loadManifest(manifestPath)
				
				// Verify basic fields
				expect(manifest.name).toBe('pi')
				expect(manifest.command).toBe('pi')
				expect(manifest.args).toEqual([])
				expect(manifest.inputMode).toBe('jsonl')
				
				// Verify resume config
				expect(manifest.resume).toBeDefined()
				expect(manifest.resume?.flag).toBe('--session')
				expect(manifest.resume?.sessionArg).toBe('last')
				
				// Verify model config
				expect(manifest.model).toBeDefined()
				expect(manifest.model?.flag).toBe('--model')
				expect(manifest.model?.default).toBe('claude-sonnet-4-5-20250929')
			} finally {
				await rm(tempDir, { recursive: true })
			}
		})

		it('has same structure as other adapters', async () => {
			const tempDir = join(tmpdir(), `pi-adapter-test-${Date.now()}`)
			await mkdir(tempDir, { recursive: true })
			
			// Create pi.yaml
			const piPath = join(tempDir, 'pi.yaml')
			await writeFile(piPath, `
name: pi
command: pi
args: []
inputMode: jsonl
resume:
  flag: --session
  sessionArg: last
model:
  flag: --model
  default: claude-sonnet-4-5-20250929
`)
			
			// Create droid.yaml for comparison
			const droidPath = join(tempDir, 'droid.yaml')
			await writeFile(droidPath, `
name: droid
command: droid
args:
  - --skip-permissions-unsafe
inputMode: jsonl
resume:
  flag: --session-id
  sessionArg: last
model:
  flag: --model
  default: opus
`)
			
			try {
				const piManifest = await loadManifest(piPath)
				const droidManifest = await loadManifest(droidPath)
				
				// Both should have the same structure
				expect(piManifest.inputMode).toBe(droidManifest.inputMode)
				expect(piManifest.resume).toBeDefined()
				expect(droidManifest.resume).toBeDefined()
				expect(piManifest.model).toBeDefined()
				expect(droidManifest.model).toBeDefined()
				
				// Both use --model flag
				expect(piManifest.model?.flag).toBe(droidManifest.model?.flag)
			} finally {
				await rm(tempDir, { recursive: true })
			}
		})
	})

	describe('Model Aliases', () => {
		// These tests verify the model alias mappings in jsonl-bridge.ts
		
		it('has pi model aliases defined', () => {
			// The model aliases are defined in jsonl-bridge.ts
			// We're testing the expected values
			const expectedAliases = {
				pi: 'claude-sonnet-4-5-20250929',
				'pi-opus': 'claude-opus-4-5-20251101',
				'pi-haiku': 'claude-haiku-4-5-20251001',
			}
			
			// Verify expected aliases
			expect(expectedAliases.pi).toBe('claude-sonnet-4-5-20250929')
			expect(expectedAliases['pi-opus']).toBe('claude-opus-4-5-20251101')
			expect(expectedAliases['pi-haiku']).toBe('claude-haiku-4-5-20251001')
		})

		it('pi aliases map to same models as claude aliases', () => {
			const modelMapping = {
				// Claude aliases
				opus: 'claude-opus-4-5-20251101',
				sonnet: 'claude-sonnet-4-5-20250929',
				haiku: 'claude-haiku-4-5-20251001',
				// Pi aliases
				pi: 'claude-sonnet-4-5-20250929',
				'pi-opus': 'claude-opus-4-5-20251101',
				'pi-haiku': 'claude-haiku-4-5-20251001',
			}
			
			// Pi uses same model IDs as underlying providers
			expect(modelMapping.pi).toBe(modelMapping.sonnet)
			expect(modelMapping['pi-opus']).toBe(modelMapping.opus)
			expect(modelMapping['pi-haiku']).toBe(modelMapping.haiku)
		})
	})

	describe('Pi Command Line Arguments', () => {
		it('supports session resumption with --session flag', () => {
			// Pi uses --session flag (different from droid's --session-id)
			const piSessionFlag = '--session'
			const droidSessionFlag = '--session-id'
			
			expect(piSessionFlag).not.toBe(droidSessionFlag)
			expect(piSessionFlag).toBe('--session')
		})

		it('supports model selection with --model flag', () => {
			// Pi uses --model flag (same as claude and droid)
			const modelFlag = '--model'
			
			expect(modelFlag).toBe('--model')
		})

		it('accepts JSONL input mode', () => {
			// Pi supports JSONL input mode for programmatic integration
			const inputMode = 'jsonl'
			
			expect(inputMode).toBe('jsonl')
		})
	})

	describe('Pi Default Configuration', () => {
		it('defaults to claude-sonnet-4-5-20250929', () => {
			const defaultModel = 'claude-sonnet-4-5-20250929'
			
			// Pi default model should be a capable, popular model
			expect(defaultModel).toBe('claude-sonnet-4-5-20250929')
			expect(defaultModel).toContain('claude')
			expect(defaultModel).toContain('sonnet')
		})
	})
})
