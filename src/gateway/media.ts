import { createWriteStream, createReadStream } from 'node:fs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import type { ReadableStream } from 'node:stream/web'
import type { Bot } from 'grammy'
import type { Attachment } from '../protocol/types.js'
import FormData from 'form-data'
import { log } from '../logging/file.js'

const TRANSCRIPTS_DIR = path.join(homedir(), 'files', 'transcripts')
const MEDIA_DIR = path.join(homedir(), 'files', 'media')
const MAX_INLINE_CHARS = 2000 // inline if transcript is shorter than this

// Transcription provider: 'local' uses local whisper CLI, 'openai' uses OpenAI API
const TRANSCRIPTION_PROVIDER = process.env.TRANSCRIPTION_PROVIDER || 'local'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''

export type TranscriptResult = {
	text: string
	path: string
	isInline: boolean
}

/**
 * Download a Telegram file to local storage
 */
export const downloadTelegramFile = async (
	bot: Bot,
	fileId: string,
	extension: string
): Promise<string> => {
	await mkdir(MEDIA_DIR, { recursive: true })

	const file = await bot.api.getFile(fileId)
	if (!file.file_path) {
		throw new Error('Failed to get file path from Telegram')
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
	const filename = `${timestamp}${extension}`
	const localPath = path.join(MEDIA_DIR, filename)

	const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`
	const response = await fetch(fileUrl)
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download file: ${response.status}`)
	}

	const writeStream = createWriteStream(localPath)
	const webStream = response.body as ReadableStream<Uint8Array>
	await pipeline(Readable.fromWeb(webStream), writeStream)

	return localPath
}

/**
 * Transcribe audio file using local Whisper CLI
 */
const transcribeLocal = async (audioPath: string, transcriptPath: string): Promise<string> => {
	return new Promise((resolve, reject) => {
		// Use openai-whisper CLI (installed via brew)
		const whisper = spawn('/opt/homebrew/bin/whisper', [
			audioPath,
			'--model', 'base',
			'--language', 'en',
			'--output_format', 'txt',
			'--output_dir', TRANSCRIPTS_DIR,
		])

		let stderr = ''
		whisper.stderr.on('data', (data) => {
			stderr += data.toString()
		})

		whisper.on('close', async (code) => {
			if (code !== 0) {
				reject(new Error(`Whisper failed: ${stderr}`))
				return
			}

			// Whisper outputs to {input_basename}.txt
			const basename = path.basename(audioPath, path.extname(audioPath))
			const whisperOutput = path.join(TRANSCRIPTS_DIR, `${basename}.txt`)

			try {
				const { rename } = await import('node:fs/promises')
				// Rename to our preferred format
				await rename(whisperOutput, transcriptPath)
				const text = await readFile(transcriptPath, 'utf-8')
				resolve(text.trim())
			} catch (err) {
				reject(err)
			}
		})

		whisper.on('error', reject)
	})
}

/**
 * Transcribe audio file using OpenAI Whisper API
 */
const transcribeOpenAI = async (audioPath: string, transcriptPath: string): Promise<string> => {
	if (!OPENAI_API_KEY) {
		throw new Error('OPENAI_API_KEY not set - cannot use OpenAI transcription')
	}

	const form = new FormData()
	form.append('file', createReadStream(audioPath))
	form.append('model', 'whisper-1')
	form.append('language', 'en')

	// Use form-data's submit() since fetch doesn't handle form-data streams properly
	return new Promise((resolve, reject) => {
		form.submit({
			protocol: 'https:',
			host: 'api.openai.com',
			path: '/v1/audio/transcriptions',
			headers: {
				'Authorization': `Bearer ${OPENAI_API_KEY}`,
			}
		}, async (err, res) => {
			if (err) {
				reject(err)
				return
			}

			let data = ''
			res.on('data', (chunk: Buffer) => data += chunk.toString())
			res.on('end', async () => {
				try {
					if (res.statusCode !== 200) {
						reject(new Error(`OpenAI transcription failed: ${res.statusCode} ${data}`))
						return
					}

					const result = JSON.parse(data) as { text: string }
					const text = result.text.trim()

					// Save transcript to file
					await writeFile(transcriptPath, text, 'utf-8')
					resolve(text)
				} catch (parseErr) {
					reject(parseErr)
				}
			})
			res.on('error', reject)
		})
	})
}

/**
 * Transcribe audio file using configured provider (local or openai)
 */
export const transcribeAudio = async (audioPath: string): Promise<TranscriptResult> => {
	await mkdir(TRANSCRIPTS_DIR, { recursive: true })

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
	const transcriptPath = path.join(TRANSCRIPTS_DIR, `${timestamp}-voice.txt`)

	const provider = TRANSCRIPTION_PROVIDER
	log(`[media] Transcribing with provider: ${provider}`)

	let text: string
	if (provider === 'openai') {
		text = await transcribeOpenAI(audioPath, transcriptPath)
	} else {
		text = await transcribeLocal(audioPath, transcriptPath)
	}

	return {
		text,
		path: transcriptPath,
		isInline: text.length <= MAX_INLINE_CHARS,
	}
}

/**
 * Get file extension from mime type or attachment type
 */
const getExtension = (attachment: Attachment): string => {
	if (attachment.mimeType) {
		const ext = attachment.mimeType.split('/')[1]
		if (ext === 'ogg' || ext === 'oga') return '.ogg'
		if (ext === 'mpeg') return '.mp3'
		if (ext === 'mp4') return '.m4a'
		if (ext === 'wav') return '.wav'
	}
	// Default extensions by type
	if (attachment.type === 'voice') return '.ogg'
	if (attachment.type === 'audio') return '.mp3'
	return '.bin'
}

/**
 * Process voice/audio attachment: download + transcribe
 * Returns the prompt text to inject
 */
export const processVoiceAttachment = async (
	bot: Bot,
	attachment: Attachment
): Promise<string> => {
	log(`[media] Processing ${attachment.type} attachment...`)

	// Download the file (if not already available)
	const extension = getExtension(attachment)
	const audioPath = attachment.localPath ?? await downloadTelegramFile(bot, attachment.fileId, extension)
	log(`[media] Downloaded to ${audioPath}`)

	// Transcribe
	log(`[media] Transcribing...`)
	const result = await transcribeAudio(audioPath)
	log(`[media] Transcribed: ${result.text.length} chars`)

	// Format the prompt injection
	if (result.isInline) {
		return `[Voice note transcript:]\n${result.text}`
	} else {
		return `[Voice note transcript saved: ${result.path}]\n(${result.text.length} chars - use Read tool to view)`
	}
}

/**
 * Check if attachment is voice/audio
 */
export const isVoiceAttachment = (attachment: Attachment): boolean => {
	return attachment.type === 'voice' || attachment.type === 'audio'
}
