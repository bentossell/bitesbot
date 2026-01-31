import { mkdir, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const args = process.argv.slice(2)
const prompt = args[args.length - 1] ?? ''

const payloadMatch = prompt.match(/E2E_PAYLOAD:({[\s\S]*})/)
let payload = {}
if (payloadMatch?.[1]) {
	try {
		payload = JSON.parse(payloadMatch[1])
	} catch {
		payload = {}
	}
}

const action = payload.action ?? 'echo'
const sessionId = payload.sessionId ?? `mock-${Date.now()}`
const sleepMs = Number(payload.sleepMs ?? 0)

const emit = (event) => {
	process.stdout.write(`${JSON.stringify(event)}\n`)
}

emit({ type: 'session_start', session_id: sessionId, model: 'mock-1' })

if (sleepMs > 0) {
	await delay(sleepMs)
}

let resultText = ''

if (action === 'write') {
	const path = payload.path
	const content = String(payload.content ?? '')
	if (!path) {
		resultText = 'Error: missing path'
	} else {
		emit({ type: 'tool_start', tool: 'Write', id: 'tool-write', input: { path, content } })
		try {
			await mkdir(dirname(path), { recursive: true })
			await writeFile(path, content, 'utf-8')
			emit({ type: 'tool_end', id: 'tool-write', output: 'ok' })
			resultText = `Wrote ${path}`
		} catch (error) {
			const message = error instanceof Error ? error.message : 'unknown error'
			emit({ type: 'tool_end', id: 'tool-write', error: message })
			resultText = `Error: ${message}`
		}
	}
} else if (action === 'read') {
	const path = payload.path
	if (!path) {
		resultText = 'Error: missing path'
	} else {
		emit({ type: 'tool_start', tool: 'Read', id: 'tool-read', input: { path } })
		try {
			const content = await readFile(path, 'utf-8')
			emit({ type: 'tool_end', id: 'tool-read', output: content })
			resultText = content
		} catch (error) {
			const message = error instanceof Error ? error.message : 'unknown error'
			emit({ type: 'tool_end', id: 'tool-read', error: message })
			resultText = `Error: ${message}`
		}
	}
} else if (action === 'spawn') {
	resultText = payload.text ?? 'Subagent completed'
} else {
	resultText = payload.text ?? `Echo: ${prompt}`
}

emit({ type: 'message', role: 'assistant', text: resultText })
emit({ type: 'completion', finalText: resultText, session_id: sessionId })
