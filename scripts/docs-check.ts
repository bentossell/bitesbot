import { readFile, readdir } from 'node:fs/promises'

const rootUrl = new URL('../', import.meta.url)

const readText = (relativePath: string) => readFile(new URL(relativePath, rootUrl), 'utf8')

const errors: string[] = []

const checkNoNpm = async (relativePath: string) => {
	const content = await readText(relativePath)
	if (/\bnpm\b/.test(content)) {
		errors.push(`${relativePath}: replace npm references with pnpm`)
	}
	return content
}

const extractParseCommandBlock = (source: string) => {
	const start = source.indexOf('const parseCommand')
	if (start === -1) {
		errors.push('src/bridge/jsonl-bridge.ts: parseCommand not found')
		return null
	}
	const end = source.indexOf('const sendToGateway', start)
	if (end === -1) {
		errors.push('src/bridge/jsonl-bridge.ts: parseCommand end not found')
		return null
	}
	return source.slice(start, end)
}

const extractModelAliases = (source: string) => {
	const start = source.indexOf('const modelAliases')
	if (start === -1) {
		errors.push('src/bridge/jsonl-bridge.ts: modelAliases not found')
		return []
	}
	const braceStart = source.indexOf('{', start)
	const braceEnd = source.indexOf('}', braceStart + 1)
	if (braceStart === -1 || braceEnd === -1) {
		errors.push('src/bridge/jsonl-bridge.ts: modelAliases block malformed')
		return []
	}
	const body = source.slice(braceStart + 1, braceEnd)
	return Array.from(body.matchAll(/^\s*([a-z0-9-]+):/gmi)).map((match) => match[1])
}

const main = async () => {
	const docsWithCommands = [
		'AGENTS.md',
		'README.md',
		'README-LINKS.md',
		'docs/ops.md',
		'tests/AGENTS.md',
	]

	const [bridgeDoc, testsAgents, bridgeSource] = await Promise.all([
		readText('docs/bridge.md'),
		readText('tests/AGENTS.md'),
		readText('src/bridge/jsonl-bridge.ts'),
	])

	await Promise.all(docsWithCommands.map(checkNoNpm))

	const parseCommandBlock = extractParseCommandBlock(bridgeSource)
	if (parseCommandBlock) {
		const commands = new Set<string>()
		const addMatches = (pattern: RegExp) => {
			for (const match of parseCommandBlock.matchAll(pattern)) {
				commands.add(match[1])
			}
		}
		addMatches(/trimmed === '\/([a-z-]+)'/g)
		addMatches(/trimmed\.startsWith\('\/([a-z-]+)/g)
		addMatches(/slashCommand\?\.command === '([a-z-]+)'/g)

		const missing = Array.from(commands).filter((command) => !bridgeDoc.includes(`/${command}`))
		if (missing.length > 0) {
			errors.push(`docs/bridge.md: missing slash commands: ${missing.sort().join(', ')}`)
		}
	}

	const aliases = extractModelAliases(bridgeSource)
	if (aliases.length === 0) {
		errors.push('src/bridge/jsonl-bridge.ts: modelAliases extraction failed')
	} else {
		const missingAliases = aliases.filter((alias) => !bridgeDoc.includes(alias))
		if (missingAliases.length > 0) {
			errors.push(`docs/bridge.md: missing model aliases: ${missingAliases.sort().join(', ')}`)
		}
	}

	const adapterEntries = await readdir(new URL('adapters/', rootUrl), { withFileTypes: true })
	const adapterNames = adapterEntries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
		.map((entry) => entry.name.replace(/\.yaml$/, ''))

	const missingAdapters = adapterNames.filter((name) => !bridgeDoc.includes(name))
	if (missingAdapters.length > 0) {
		errors.push(`docs/bridge.md: missing adapter names: ${missingAdapters.sort().join(', ')}`)
	}

	if (!bridgeDoc.includes('/restart@')) {
		errors.push('docs/bridge.md: mention /restart@<bot> support')
	}

	const requiredE2E = [
		'TG_E2E_RUN',
		'TG_E2E_API_ID',
		'TG_E2E_API_HASH',
		'TG_E2E_SESSION',
		'TG_E2E_BOT_TOKEN',
		'TG_E2E_BOT_USERNAME',
	]
	const missingE2E = requiredE2E.filter((env) => !testsAgents.includes(env))
	if (missingE2E.length > 0) {
		errors.push(`tests/AGENTS.md: missing e2e env vars: ${missingE2E.join(', ')}`)
	}

	if (errors.length > 0) {
		console.error('Docs check failed:')
		for (const error of errors) {
			console.error(`- ${error}`)
		}
		process.exit(1)
	}

	console.log('Docs check passed.')
}

void main()
