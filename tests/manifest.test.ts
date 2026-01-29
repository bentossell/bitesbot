import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { loadManifest, loadAllManifests } from '../src/bridge/manifest.js'

describe('loadManifest', () => {
	it('parses valid YAML manifest', async () => {
		const tempDir = join(tmpdir(), `manifest-test-${Date.now()}`)
		await mkdir(tempDir, { recursive: true })
		const manifestPath = join(tempDir, 'test.yaml')
		
		await writeFile(manifestPath, `
name: test-cli
command: echo
args:
  - --verbose
  - --output
inputMode: arg
workingDirFlag: --cwd
resume:
  flag: --resume
  sessionArg: last
systemPromptArg: --append-system-prompt
systemPromptWhen: first
`)
		
		try {
			const manifest = await loadManifest(manifestPath)
			expect(manifest.name).toBe('test-cli')
			expect(manifest.command).toBe('echo')
			expect(manifest.args).toEqual(['--verbose', '--output'])
			expect(manifest.inputMode).toBe('arg')
			expect(manifest.workingDirFlag).toBe('--cwd')
			expect(manifest.resume).toEqual({ flag: '--resume', sessionArg: 'last' })
			expect(manifest.systemPromptArg).toBe('--append-system-prompt')
			expect(manifest.systemPromptWhen).toBe('first')
		} finally {
			await rm(tempDir, { recursive: true })
		}
	})

	it('defaults inputMode to jsonl', async () => {
		const tempDir = join(tmpdir(), `manifest-test-${Date.now()}`)
		await mkdir(tempDir, { recursive: true })
		const manifestPath = join(tempDir, 'minimal.yaml')
		
		await writeFile(manifestPath, `
name: minimal
command: echo
`)
		
		try {
			const manifest = await loadManifest(manifestPath)
			expect(manifest.inputMode).toBe('jsonl')
			expect(manifest.args).toEqual([])
		} finally {
			await rm(tempDir, { recursive: true })
		}
	})

	it('throws for missing name', async () => {
		const tempDir = join(tmpdir(), `manifest-test-${Date.now()}`)
		await mkdir(tempDir, { recursive: true })
		const manifestPath = join(tempDir, 'invalid.yaml')
		
		await writeFile(manifestPath, `
command: echo
`)
		
		try {
			await expect(loadManifest(manifestPath)).rejects.toThrow("missing or invalid 'name'")
		} finally {
			await rm(tempDir, { recursive: true })
		}
	})

	it('throws for missing command', async () => {
		const tempDir = join(tmpdir(), `manifest-test-${Date.now()}`)
		await mkdir(tempDir, { recursive: true })
		const manifestPath = join(tempDir, 'invalid.yaml')
		
		await writeFile(manifestPath, `
name: test
`)
		
		try {
			await expect(loadManifest(manifestPath)).rejects.toThrow("missing or invalid 'command'")
		} finally {
			await rm(tempDir, { recursive: true })
		}
	})
})

describe('loadAllManifests', () => {
	it('returns empty map for non-existent directory', async () => {
		const manifests = await loadAllManifests('/nonexistent/path')
		expect(manifests.size).toBe(0)
	})

	it('loads multiple manifests from directory', async () => {
		const tempDir = join(tmpdir(), `manifests-test-${Date.now()}`)
		await mkdir(tempDir, { recursive: true })
		
		// Create manifests with commands that exist on any system
		await writeFile(join(tempDir, 'echo.yaml'), `
name: echo-cli
command: /bin/echo
args: []
`)
		await writeFile(join(tempDir, 'cat.yaml'), `
name: cat-cli
command: /bin/cat
args: []
`)
		// Create a non-yaml file that should be ignored
		await writeFile(join(tempDir, 'readme.txt'), 'ignore me')
		
		try {
			const manifests = await loadAllManifests(tempDir)
			expect(manifests.size).toBe(2)
			expect(manifests.has('echo-cli')).toBe(true)
			expect(manifests.has('cat-cli')).toBe(true)
		} finally {
			await rm(tempDir, { recursive: true })
		}
	})

	it('skips manifests where command does not exist', async () => {
		const tempDir = join(tmpdir(), `manifests-test-${Date.now()}`)
		await mkdir(tempDir, { recursive: true })
		
		await writeFile(join(tempDir, 'missing.yaml'), `
name: missing-cli
command: /definitely/does/not/exist/anywhere
`)
		
		try {
			const manifests = await loadAllManifests(tempDir)
			expect(manifests.size).toBe(0)
		} finally {
			await rm(tempDir, { recursive: true })
		}
	})
})
