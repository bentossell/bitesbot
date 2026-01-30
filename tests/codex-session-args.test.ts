import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { CLIManifest } from '../src/bridge/manifest.js'

const spawnMock = vi.fn((_command: string, _args: string[]) => {
	void _command
	void _args
	const stdout = new PassThrough()
	const stderr = new PassThrough()
	return {
		stdin: { end: vi.fn() },
		stdout,
		stderr,
		on: vi.fn().mockReturnThis(),
	} as unknown as ChildProcess
})

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const createManifest = (): CLIManifest => ({
	name: 'codex',
	command: 'codex',
	args: ['--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'],
	inputMode: 'arg',
	workingDirFlag: '--cd',
	model: { flag: '--model', default: 'gpt-5.2-codex' },
})

const createSession = async (workingDir: string) => {
	const { JsonlSession } = await import('../src/bridge/jsonl-session.js')
	return new JsonlSession('chat-1', createManifest(), workingDir)
}

describe('Codex session args', () => {
	beforeEach(() => {
		spawnMock.mockClear()
	})

	it('builds exec args without resume', async () => {
		const session = await createSession('/workdir')
		session.run('hello')

		expect(spawnMock).toHaveBeenCalledTimes(1)
		const [command, args] = spawnMock.mock.calls[0]
		expect(command).toBe('codex')
		expect(args).toEqual([
			'exec',
			'--json',
			'--dangerously-bypass-approvals-and-sandbox',
			'--skip-git-repo-check',
			'--cd',
			'/workdir',
			'--model',
			'gpt-5.2-codex',
			'hello',
		])
	})

	it('builds exec resume args with session id before prompt', async () => {
		const session = await createSession('/workdir')
		session.run('next', { engine: 'codex', sessionId: 'sess-123' })

		expect(spawnMock).toHaveBeenCalledTimes(1)
		const [command, args] = spawnMock.mock.calls[0]
		expect(command).toBe('codex')
		expect(args).toEqual([
			'exec',
			'resume',
			'--json',
			'--dangerously-bypass-approvals-and-sandbox',
			'--skip-git-repo-check',
			'--cd',
			'/workdir',
			'--model',
			'gpt-5.2-codex',
			'sess-123',
			'next',
		])
	})
})
