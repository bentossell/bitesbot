import { randomUUID } from 'node:crypto'
import type { BridgeEvent } from './jsonl-session.js'
import type { Attachment, ContentBlock, NormalizedResponse } from '../protocol/normalized.js'
import { extractSendfileCommands } from './sendfile.js'

type TextSegment = { type: 'text'; text: string }
type ToolSegment = {
	type: 'tool_status'
	name: string
	status: 'start' | 'end' | 'error'
	preview?: string
	toolId?: string
	raw?: unknown
}
type ErrorSegment = { type: 'error'; text: string }
type Segment = TextSegment | ToolSegment | ErrorSegment

type NormalizeOptions = {
	chatId: number | string
	cli: string
	model?: string
	transport?: string
	transportThreadId?: string
	conversationId?: string
	sessionId?: string
	verbose?: boolean
	streaming?: boolean
}

const mergeText = (current: string, next: string): string => {
	if (!current) return next
	if (next.startsWith(current)) return next
	if (current.startsWith(next)) return current
	return `${current}${next}`
}

const parseMarkdownBlocks = (text: string): ContentBlock[] => {
	const blocks: ContentBlock[] = []
	const lines = text.split('\n')
	let paragraph: string[] = []

	const flushParagraph = () => {
		if (paragraph.length === 0) return
		blocks.push({ type: 'text', text: paragraph.join('\n'), format: 'markdown' })
		paragraph = []
	}

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? ''
		const trimmed = line.trim()

		if (trimmed.startsWith('```')) {
			flushParagraph()
			const language = trimmed.slice(3).trim() || undefined
			const codeLines: string[] = []
			for (i += 1; i < lines.length; i += 1) {
				const nextLine = lines[i] ?? ''
				if (nextLine.trim().startsWith('```')) break
				codeLines.push(nextLine)
			}
			blocks.push({ type: 'code', text: codeLines.join('\n'), language })
			continue
		}

		const headingMatch = /^(#{1,3})\s+(.*)$/.exec(trimmed)
		if (headingMatch) {
			flushParagraph()
			const level = headingMatch[1]?.length as 1 | 2 | 3
			blocks.push({ type: 'heading', level, text: headingMatch[2] ?? '' })
			continue
		}

		const bulletMatch = /^[-*•]\s+(.+)$/.exec(trimmed)
		const numberedMatch = /^(\d+)\.\s+(.+)$/.exec(trimmed)
		if (bulletMatch || numberedMatch) {
			flushParagraph()
			const style = bulletMatch ? 'bulleted' : 'numbered'
			const items: string[] = []
			let cursor = i
			while (cursor < lines.length) {
				const candidate = (lines[cursor] ?? '').trim()
				const bullet = /^[-*•]\s+(.+)$/.exec(candidate)
				const numbered = /^(\d+)\.\s+(.+)$/.exec(candidate)
				if (style === 'bulleted' && bullet) {
					items.push(bullet[1] ?? '')
				} else if (style === 'numbered' && numbered) {
					items.push(numbered[2] ?? '')
				} else {
					break
				}
				cursor += 1
			}
			blocks.push({ type: 'list', style, items })
			i = cursor - 1
			continue
		}

		paragraph.push(line)
	}

	flushParagraph()

	return blocks
}

export const normalizeBridgeEvents = (events: BridgeEvent[], options: NormalizeOptions): NormalizedResponse => {
	const segments: Segment[] = []
	const toolNames = new Map<string, string>()
	const attachments: Attachment[] = []
	let currentText = ''
	let sessionId = options.sessionId
	let toolCount = 0
	let costUsd: number | undefined
	let completedError: string | undefined

	const flushText = () => {
		if (!currentText) return
		segments.push({ type: 'text', text: currentText })
		currentText = ''
	}

	const pushAttachment = (file: { path: string; caption?: string }) => {
		if (attachments.some((existing) => existing.path === file.path)) return
		attachments.push({ kind: 'file', path: file.path, caption: file.caption })
	}

	for (const evt of events) {
		switch (evt.type) {
			case 'started':
				sessionId = evt.sessionId
				break
			case 'text':
				currentText = mergeText(currentText, evt.text)
				break
			case 'tool_start':
				toolCount += 1
				toolNames.set(evt.toolId, evt.name)
				if (options.verbose) {
					flushText()
					segments.push({
						type: 'tool_status',
						name: evt.name,
						status: 'start',
						toolId: evt.toolId,
						raw: evt.input,
					})
				}
				break
			case 'tool_end': {
				const toolName = toolNames.get(evt.toolId) ?? 'tool'
				toolNames.delete(evt.toolId)
				if (options.verbose) {
					flushText()
					segments.push({
						type: 'tool_status',
						name: toolName,
						status: evt.isError ? 'error' : 'end',
						preview: evt.preview,
						toolId: evt.toolId,
						raw: evt.preview,
					})
				}
				break
			}
			case 'completed':
				costUsd = evt.cost
				if (evt.isError) {
					completedError = evt.answer || 'error'
					break
				}
				if (evt.answer) {
					currentText = mergeText(currentText, evt.answer)
				}
				break
			case 'error':
				flushText()
				segments.push({ type: 'error', text: evt.message })
				break
			default:
				break
		}
	}

	if (completedError) {
		flushText()
		segments.push({ type: 'error', text: completedError })
	} else {
		flushText()
	}

	const content: ContentBlock[] = []
	for (const segment of segments) {
		if (segment.type === 'text') {
			const { files, remainingText } = extractSendfileCommands(segment.text)
			files.forEach(pushAttachment)
			const cleaned = remainingText.trim()
			if (cleaned) {
				content.push(...parseMarkdownBlocks(cleaned))
			}
			continue
		}
		if (segment.type === 'tool_status') {
			content.push(segment)
			continue
		}
		if (segment.type === 'error') {
			content.push({ type: 'error', text: segment.text })
		}
	}

	return {
		schemaVersion: 1,
		messageId: randomUUID(),
		conversationId: options.conversationId ?? String(options.chatId),
		transport: options.transport,
		transportThreadId: options.transportThreadId,
		sessionId,
		cli: options.cli,
		model: options.model,
		timestamp: new Date().toISOString(),
		content,
		attachments: attachments.length ? attachments : undefined,
		meta: {
			costUsd,
			streaming: options.streaming,
			toolCount,
		},
	}
}
