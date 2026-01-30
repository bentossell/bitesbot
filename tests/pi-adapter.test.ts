import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { describe, it, expect } from 'vitest'
import { loadManifest } from '../src/bridge/manifest.js'

describe('Pi adapter', () => {
	it('parses pi.yaml manifest correctly', async () => {
		const tempDir = join(tmpdir(), `pi-manifest-test-${Date.now()}`)
		await mkdir(tempDir, { recursive: true })
		const manifestPath = join(tempDir, 'pi.yaml')

		await writeFile(manifestPath, `
name: pi
command: pi
args:
  - --mode
  - json
inputMode: arg
resume:
  flag: --session
  sessionArg: last
model:
  flag: --model
  default: ""
`)

		try {
			const manifest = await loadManifest(manifestPath)
			expect(manifest.name).toBe('pi')
			expect(manifest.command).toBe('pi')
			expect(manifest.args).toEqual(['--mode', 'json'])
			expect(manifest.inputMode).toBe('arg')
			expect(manifest.resume).toEqual({ flag: '--session', sessionArg: 'last' })
			expect(manifest.model).toEqual({ flag: '--model', default: '' })
		} finally {
			await rm(tempDir, { recursive: true })
		}
	})
})
