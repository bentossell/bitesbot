import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import type { Bot } from 'grammy'
import type { Attachment } from '../protocol/types.js'

const TRANSCRIPTS_DIR = path.join(homedir(), 'files', 'transcripts')
const MEDIA_DIR = path.join(homedir(), 'files', 'media')
const MAX_INLINE_CHARS = 2000 // inline if transcript is shorter than this

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
	await pipeline(Readable.fromWeb(response.body as any), writeStream)

	return localPath
}

/**
 * Transcribe audio file using Whisper
 */
export const transcribeAudio = async (audioPath: string): Promise<TranscriptResult> => {
	await mkdir(TRANSCRIPTS_DIR, { recursive: true })

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
	const transcriptPath = path.join(TRANSCRIPTS_DIR, `${timestamp}-voice.txt`)

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
				const { readFile, rename } = await import('node:fs/promises')
				// Rename to our preferred format
				await rename(whisperOutput, transcriptPath)
				const text = await readFile(transcriptPath, 'utf-8')
				const trimmed = text.trim()

				resolve({
					text: trimmed,
					path: transcriptPath,
					isInline: trimmed.length <= MAX_INLINE_CHARS,
				})
			} catch (err) {
				reject(err)
			}
		})

		whisper.on('error', reject)
	})
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
	console.log(`[media] Processing ${attachment.type} attachment...`)

	// Download the file
	const extension = getExtension(attachment)
	const audioPath = await downloadTelegramFile(bot, attachment.fileId, extension)
	console.log(`[media] Downloaded to ${audioPath}`)

	// Transcribe
	console.log(`[media] Transcribing...`)
	const result = await transcribeAudio(audioPath)
	console.log(`[media] Transcribed: ${result.text.length} chars`)

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
