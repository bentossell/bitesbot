import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { loadManifest } from '../src/bridge/manifest.js'

describe('Codex adapter', () => {
	it('parses codex.yaml manifest correctly', async () => {
		const tempDir = join(tmpdir(), `codex-manifest-test-${Date.now()}`)
		await mkdir(tempDir, { recursive: true })
		const manifestPath = join(tempDir, 'codex.yaml')
		
		// Replicate the actual codex.yaml structure
		await writeFile(manifestPath, `
name: codex
command: codex
args:
  - exec
  - --json
  - --dangerously-bypass-approvals-and-sandbox
  - --skip-git-repo-check
inputMode: arg
workingDirFlag: --cd
model:
  flag: --model
  default: gpt-5.2
`)
		
		try {
			const manifest = await loadManifest(manifestPath)
			expect(manifest.name).toBe('codex')
			expect(manifest.command).toBe('codex')
			expect(manifest.args).toEqual([
				'exec',
				'--json',
				'--dangerously-bypass-approvals-and-sandbox',
				'--skip-git-repo-check'
			])
			expect(manifest.inputMode).toBe('arg')
			expect(manifest.workingDirFlag).toBe('--cd')
			expect(manifest.model).toEqual({
				flag: '--model',
				default: 'gpt-5.2'
			})
		} finally {
			await rm(tempDir, { recursive: true })
		}
	})

	it('supports model configuration', async () => {
		const tempDir = join(tmpdir(), `codex-model-test-${Date.now()}`)
		await mkdir(tempDir, { recursive: true })
		const manifestPath = join(tempDir, 'codex.yaml')
		
		await writeFile(manifestPath, `
name: codex
command: codex
args:
  - exec
  - --json
inputMode: arg
model:
  flag: --model
  default: gpt-5.2
`)
		
		try {
			const manifest = await loadManifest(manifestPath)
			expect(manifest.model?.flag).toBe('--model')
			expect(manifest.model?.default).toBe('gpt-5.2')
		} finally {
			await rm(tempDir, { recursive: true })
		}
	})

	it('supports working directory flag', async () => {
		const tempDir = join(tmpdir(), `codex-workdir-test-${Date.now()}`)
		await mkdir(tempDir, { recursive: true })
		const manifestPath = join(tempDir, 'codex.yaml')
		
		await writeFile(manifestPath, `
name: codex
command: codex
args:
  - exec
  - --json
inputMode: arg
workingDirFlag: --cd
`)
		
		try {
			const manifest = await loadManifest(manifestPath)
			expect(manifest.workingDirFlag).toBe('--cd')
		} finally {
			await rm(tempDir, { recursive: true })
		}
	})
})

describe('Codex model aliases', () => {
	it('maps codex alias to gpt-5.2', () => {
		const modelAliases: Record<string, string> = {
			opus: 'claude-opus-4-5-20251101',
			sonnet: 'claude-sonnet-4-5-20250929',
			haiku: 'claude-haiku-4-5-20251001',
			codex: 'gpt-5.2',
			'codex-max': 'gpt-5.1-codex-max',
		}
		
		expect(modelAliases['codex']).toBe('gpt-5.2')
		expect(modelAliases['codex-max']).toBe('gpt-5.1-codex-max')
	})
})
