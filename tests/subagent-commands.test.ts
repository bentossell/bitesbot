import { describe, it, expect } from 'vitest'
import {
	parseSpawnCommand,
	parseSubagentsCommand,
	formatSubagentList,
	formatSubagentAnnouncement,
} from '../src/bridge/subagent-commands.js'
import type { SubagentRunRecord } from '../src/bridge/subagent-registry.js'

describe('parseSpawnCommand', () => {
	it('parses simple quoted task', () => {
		const result = parseSpawnCommand('/spawn "do something"')
		expect(result).toEqual({ task: 'do something' })
	})

	it('parses unquoted task', () => {
		const result = parseSpawnCommand('/spawn do something')
		expect(result).toEqual({ task: 'do something' })
	})

	it('parses --label flag', () => {
		const result = parseSpawnCommand('/spawn --label "Research" "find docs"')
		expect(result).toEqual({ task: 'find docs', label: 'Research' })
	})

	it('parses --cli flag', () => {
		const result = parseSpawnCommand('/spawn --cli droid "task here"')
		expect(result).toEqual({ task: 'task here', cli: 'droid' })
	})

	it('parses both --label and --cli', () => {
		const result = parseSpawnCommand('/spawn --label "Test" --cli claude "run tests"')
		expect(result).toEqual({ task: 'run tests', label: 'Test', cli: 'claude' })
	})

	it('parses --cli before --label', () => {
		const result = parseSpawnCommand('/spawn --cli droid --label "Deploy" "deploy app"')
		expect(result).toEqual({ task: 'deploy app', label: 'Deploy', cli: 'droid' })
	})

	it('returns null for empty spawn', () => {
		expect(parseSpawnCommand('/spawn')).toBeNull()
		expect(parseSpawnCommand('/spawn   ')).toBeNull()
	})

	it('returns null for non-spawn commands', () => {
		expect(parseSpawnCommand('/status')).toBeNull()
		expect(parseSpawnCommand('spawn task')).toBeNull()
	})

	it('handles unterminated quotes', () => {
		const result = parseSpawnCommand('/spawn "task without end quote')
		expect(result).toEqual({ task: 'task without end quote' })
	})
})

describe('parseSubagentsCommand', () => {
	it('parses /subagents as list', () => {
		expect(parseSubagentsCommand('/subagents')).toEqual({ action: 'list' })
	})

	it('parses /subagents list', () => {
		expect(parseSubagentsCommand('/subagents list')).toEqual({ action: 'list' })
	})

	it('parses /subagents stop all', () => {
		expect(parseSubagentsCommand('/subagents stop all')).toEqual({ action: 'stop-all' })
	})

	it('parses /subagents stop <id>', () => {
		expect(parseSubagentsCommand('/subagents stop abc123')).toEqual({ action: 'stop', target: 'abc123' })
	})

	it('parses /subagents log <id>', () => {
		expect(parseSubagentsCommand('/subagents log abc123')).toEqual({ action: 'log', target: 'abc123' })
	})

	it('returns null for non-subagents command', () => {
		expect(parseSubagentsCommand('/spawn "task"')).toBeNull()
	})

	it('returns null for invalid subcommand', () => {
		expect(parseSubagentsCommand('/subagents invalid')).toBeNull()
	})
})

describe('formatSubagentList', () => {
	it('returns "No subagents." for empty list', () => {
		expect(formatSubagentList([])).toBe('No subagents.')
	})

	it('formats single subagent', () => {
		const records: SubagentRunRecord[] = [{
			runId: 'abc12345-6789',
			chatId: 123,
			task: 'run tests',
			cli: 'droid',
			label: 'Tests',
			status: 'running',
			createdAt: Date.now() - 5000,
			startedAt: Date.now() - 5000,
		}]
		const result = formatSubagentList(records)
		expect(result).toContain('📋 Subagents:')
		expect(result).toContain('#abc12345')
		expect(result).toContain('droid')
		expect(result).toContain('"Tests"')
		expect(result).toContain('run tests')
	})

	it('truncates long task descriptions', () => {
		const longTask = 'a'.repeat(50)
		const records: SubagentRunRecord[] = [{
			runId: 'abc12345',
			chatId: 123,
			task: longTask,
			cli: 'claude',
			status: 'queued',
			createdAt: Date.now(),
		}]
		const result = formatSubagentList(records)
		expect(result).toContain('...')
		expect(result).not.toContain(longTask)
	})
})

describe('formatSubagentAnnouncement', () => {
	it('formats completed subagent', () => {
		const record: SubagentRunRecord = {
			runId: 'abc123',
			chatId: 123,
			task: 'test task',
			cli: 'droid',
			label: 'My Task',
			status: 'completed',
			createdAt: Date.now() - 10000,
			startedAt: Date.now() - 10000,
			endedAt: Date.now(),
			result: 'Task completed successfully',
		}
		const result = formatSubagentAnnouncement(record)
		expect(result).toContain('✅')
		expect(result).toContain('My Task')
		expect(result).toContain('Task completed successfully')
	})

	it('formats error subagent', () => {
		const record: SubagentRunRecord = {
			runId: 'abc123',
			chatId: 123,
			task: 'failing task',
			cli: 'claude',
			status: 'error',
			createdAt: Date.now() - 5000,
			startedAt: Date.now() - 5000,
			endedAt: Date.now(),
			error: 'Something went wrong',
		}
		const result = formatSubagentAnnouncement(record)
		expect(result).toContain('❌')
		expect(result).toContain('Something went wrong')
	})

	it('truncates very long results', () => {
		const longResult = 'x'.repeat(3000)
		const record: SubagentRunRecord = {
			runId: 'abc123',
			chatId: 123,
			task: 'task',
			cli: 'droid',
			status: 'completed',
			createdAt: Date.now(),
			result: longResult,
		}
		const result = formatSubagentAnnouncement(record)
		expect(result).toContain('...(truncated)')
		expect(result.length).toBeLessThan(longResult.length)
	})
})
