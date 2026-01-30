import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorkspaceRegistry, isWorkspaceDir, formatWorkspaceList, type WorkspaceConfig, type WorkspaceInfo } from '../src/workspace/registry.js'

describe('workspace registry', () => {
	let testDir: string
	beforeEach(async () => { testDir = join(tmpdir(), `ws-test-${Date.now()}`); await mkdir(testDir, { recursive: true }) })
	afterEach(async () => { try { await rm(testDir, { recursive: true, force: true }) } catch { } })

	describe('isWorkspaceDir', () => {
		it('returns true when AGENTS.md exists', async () => { await writeFile(join(testDir, 'AGENTS.md'), '# Test'); expect(await isWorkspaceDir(testDir)).toBe(true) })
		it('returns false when no marker files exist', async () => { expect(await isWorkspaceDir(testDir)).toBe(false) })
	})

	describe('createWorkspaceRegistry', () => {
		it('creates registry with default workspace', async () => {
			const registry = await createWorkspaceRegistry({ defaultWorkingDir: testDir })
			expect(registry.getDefault()).toBe('default')
			expect(registry.get('default')?.path).toBe(testDir)
		})
		it('loads workspaces from config', async () => {
			const ws1Dir = join(testDir, 'ws1'); await mkdir(ws1Dir, { recursive: true })
			const config: WorkspaceConfig = { default: 'personal', registry: { personal: { path: ws1Dir, name: 'Personal' } } }
			const registry = await createWorkspaceRegistry({ config })
			expect(registry.getDefault()).toBe('personal')
			expect(registry.get('personal')?.name).toBe('Personal')
		})
	})

	describe('active workspace', () => {
		it('setActive and getActive work', async () => {
			const ws1Dir = join(testDir, 'ws1'); await mkdir(ws1Dir, { recursive: true })
			const config: WorkspaceConfig = { default: 'default', registry: { personal: { path: ws1Dir, name: 'Personal' } } }
			const registry = await createWorkspaceRegistry({ config, defaultWorkingDir: testDir })
			expect(registry.getActive(123)?.id).toBe('default')
			expect(await registry.setActive(123, 'personal')).toBe(true)
			expect(registry.getActive(123)?.id).toBe('personal')
		})
		it('setActive returns false for unknown workspace', async () => {
			const registry = await createWorkspaceRegistry({ defaultWorkingDir: testDir })
			expect(await registry.setActive(123, 'nonexistent')).toBe(false)
		})
	})

	describe('formatWorkspaceList', () => {
		it('formats empty list', () => { expect(formatWorkspaceList([])).toBe('No workspaces configured.') })
		it('formats list with markers', () => {
			const ws: WorkspaceInfo[] = [{ id: 'main', name: 'Main', path: '/main', createdAt: 1, lastUsedAt: 1 }]
			expect(formatWorkspaceList(ws, 'main', 'main')).toContain('main: Main (active, default)')
		})
	})
})
