import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootstrapWorkspace } from '../src/wizard/bootstrap.js'

describe('bootstrapWorkspace', () => {
	it('creates workspace skeleton and templates', async () => {
		const root = await mkdtemp(join(tmpdir(), 'bitesbot-'))
		try {
			const result = await bootstrapWorkspace({
				workspacePath: root,
				userName: 'Ben',
				timezone: 'UTC',
				quietHours: '22:00-07:00',
				heartbeatSchedule: '0 9 * * *',
			})

			const userContent = await readFile(join(root, 'USER.md'), 'utf-8')
			expect(userContent).toContain('Ben')
			const heartContent = await readFile(join(root, 'HEARTBEAT.md'), 'utf-8')
			expect(heartContent).toContain('0 9 * * *')
			const memoryDir = await stat(join(root, 'memory'))
			expect(memoryDir.isDirectory()).toBe(true)
			expect(result.createdFiles.length).toBeGreaterThan(0)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
