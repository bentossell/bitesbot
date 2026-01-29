import { describe, expect, it } from 'vitest'
import { buildQmdArgs, parseQmdJson } from '../src/memory/qmd-client.js'
import { buildRecallEntries, formatRecallBlock, parseSnippet } from '../src/memory/recall.js'

describe('qmd client', () => {
	it('builds qmd args with collection and limits', () => {
		const args = buildQmdArgs('hello world', {
			qmdPath: '/usr/bin/qmd',
			collection: 'bites',
			maxResults: 7,
			minScore: 0.4,
		})
		expect(args).toEqual(['query', 'hello world', '--json', '-n', '7', '--min-score', '0.4', '-c', 'bites'])
	})

	it('parses qmd json output', () => {
		const output = JSON.stringify([
			{ docid: '#abc', score: 0.9, file: 'memory/foo.md', title: 'Foo', snippet: 'hi' },
		])
		const results = parseQmdJson(output)
		expect(results).toHaveLength(1)
		expect(results[0]?.file).toBe('memory/foo.md')
		expect(results[0]?.score).toBe(0.9)
	})
})

describe('memory recall formatting', () => {
	it('parses snippet header into line range', () => {
		const snippet = '@@ -12,3 @@ (10 before, 20 after)\nline1\nline2\nline3'
		const parsed = parseSnippet(snippet)
		expect(parsed.startLine).toBe(12)
		expect(parsed.endLine).toBe(14)
		expect(parsed.body).toContain('line1')
	})

	it('formats recall block with line ranges', () => {
		const entries = buildRecallEntries(
			[
				{
					docid: '#abc',
					score: 0.87,
					file: 'memory/foo.md',
					title: 'Foo',
					snippet: '@@ -5,2 @@ (0 before, 10 after)\nfirst\nsecond',
				},
			],
			{ maxResults: 3, minScore: 0.1 }
		)
		const block = formatRecallBlock(entries)
		expect(block).toContain('memory/foo.md:5-6')
		expect(block).toContain('first')
	})
})
