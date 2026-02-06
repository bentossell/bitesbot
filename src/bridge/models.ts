export const MODEL_ALIASES: Record<string, string> = {
	// Claude models
	opus: 'claude-opus-4-6',
	sonnet: 'claude-sonnet-4-5-20250929',
	haiku: 'claude-haiku-4-5-20251001',
	// OpenAI Codex models
	codex: 'gpt-5.3-codex',
	'codex-max': 'gpt-5.1-codex-max',
	// Gemini
	gemini: 'gemini-3-pro-preview',
	'gemini-flash': 'gemini-3-flash-preview',
}

export const resolveModelAlias = (model?: string): string | undefined => {
	if (!model) return undefined
	const normalized = model.toLowerCase()
	return MODEL_ALIASES[normalized] ?? model
}

export const resolveModelForCli = (cli: string, model?: string): string | undefined => {
	const resolved = resolveModelAlias(model)
	if (!resolved) return undefined
	const normalized = resolved.toLowerCase()

	if (cli === 'codex') {
		if (normalized.includes('claude') || normalized.includes('gemini')) return undefined
		return resolved
	}

	if (cli === 'claude') {
		return normalized.includes('claude') ? resolved : undefined
	}

	if (cli === 'droid') {
		if (normalized.includes('claude') || normalized.includes('codex')) return resolved
		return undefined
	}

	if (cli.startsWith('gemini')) {
		return normalized.includes('gemini') ? resolved : undefined
	}

	return resolved
}

export const getModelsForCli = (cli: string) =>
	Object.entries(MODEL_ALIASES)
		.map(([alias, id]) => ({
			alias,
			id,
			resolved: resolveModelForCli(cli, alias),
		}))
		.filter((entry) => entry.resolved)
		.map(({ alias, id }) => ({ alias, id }))
