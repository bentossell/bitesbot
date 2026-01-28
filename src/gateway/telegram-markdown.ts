const BOLD_OPEN = 'TGBOLDOPEN'
const BOLD_CLOSE = 'TGBOLDCLOSE'

const escapeMarkdownV2 = (text: string): string =>
	text.replace(new RegExp('([_*\\[\\]()~`>#+\\-=|{}.!\\\\])', 'g'), '\\$1')

export const toTelegramMarkdown = (text: string): string => {
	let result = text

	result = result.replace(/\*\*([^]*?)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`)
	result = result.replace(/^- /gm, '• ')
	result = escapeMarkdownV2(result)
	result = result.replace(new RegExp(`${BOLD_OPEN}([^]*?)${BOLD_CLOSE}`, 'g'), '*$1*')

	return result
}
