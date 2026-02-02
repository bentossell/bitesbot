export type SendfileCommand = { path: string; caption?: string }

export const stripSendfileCommands = (text: string, options?: { trim?: boolean }): string => {
	const pattern = /\[Sendfile:\s*([^\]]+)\](?:\s*\n*(?:Caption:\s*([^\n]+))?)?/gi
	const stripped = text.replace(pattern, '')
	return options?.trim === false ? stripped : stripped.trim()
}

export const extractSendfileCommands = (text: string): { files: SendfileCommand[]; remainingText: string } => {
	const pattern = /\[Sendfile:\s*([^\]]+)\](?:\s*\n*(?:Caption:\s*([^\n]+))?)?/gi
	const files: SendfileCommand[] = []

	let match
	while ((match = pattern.exec(text)) !== null) {
		const filePath = match[1].trim()
		const caption = match[2]?.trim()
		files.push({ path: filePath, caption })
	}

	const remainingText = stripSendfileCommands(text)

	return { files, remainingText }
}
