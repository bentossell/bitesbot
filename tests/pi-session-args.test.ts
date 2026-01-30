import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, it, expect, beforeEach, vi } from 'vitest'
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
	name: 'pi',
	command: 'pi',
	args: ['--mode', 'json'],
	inputMode: 'arg',
	resume: { flag: '--session', sessionArg: 'last' },
	model: { flag: '--model', default: '' },
})

const createSession = async (workingDir: string) => {
	const { JsonlSession } = await import('../src/bridge/jsonl-session.js')
	return new JsonlSession('chat-1', createManifest(), workingDir)
}

describe('Pi session args', () => {
	beforeEach(() => {
		spawnMock.mockClear()
	})

	it('builds args without resume or model', async () => {
		const session = await createSession('/workdir')
		session.run('hello')

		expect(spawnMock).toHaveBeenCalledTimes(1)
		const [command, args] = spawnMock.mock.calls[0]
		expect(command).toBe('pi')
		expect(args).toEqual([
			'--mode',
			'json',
			'hello',
		])
	})

	it('adds session and model flags when provided', async () => {
		const session = await createSession('/workdir')
		session.run('next', { engine: 'pi', sessionId: 'sess-123' }, { model: 'claude-opus-4-5-20251101' })

		expect(spawnMock).toHaveBeenCalledTimes(1)
		const [command, args] = spawnMock.mock.calls[0]
		expect(command).toBe('pi')
		expect(args).toEqual([
			'--mode',
			'json',
			'--session',
			'sess-123',
			'--model',
			'claude-opus-4-5-20251101',
			'next',
		])
	})
})
