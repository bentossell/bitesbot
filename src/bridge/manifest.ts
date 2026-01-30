import { execSync as childExecSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const expandHome = (path: string): string => {
	if (path.startsWith('~/')) {
		return join(homedir(), path.slice(2))
	}
	return path
}

const cliExists = (command: string): boolean => {
	const expanded = expandHome(command)
	// Check if it's an absolute/relative path
	if (expanded.includes('/')) {
		return existsSync(expanded)
	}
	// Otherwise use which
	try {
		childExecSync(`which ${command}`, { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

const resolveCommandPath = (command: string): string => {
	const expanded = expandHome(command)
	// If it's already a path, return expanded version
	if (expanded.includes('/')) {
		return expanded
	}
	// Otherwise resolve via which
	try {
		const result = childExecSync(`which ${command}`, { encoding: 'utf-8' })
		return result.trim()
	} catch {
		return command
	}
}

export type ResumeConfig = {
	flag: string
	sessionArg: 'last' | string
}

export type ModelConfig = {
	flag: string
	default: string
}

export type CLIManifest = {
	name: string
	command: string
	args: string[]
	inputMode: 'stdin' | 'arg' | 'jsonl'
	workingDirFlag?: string
	resume?: ResumeConfig
	model?: ModelConfig
}

const validateManifest = (data: unknown, filename: string): CLIManifest => {
	const obj = data as Record<string, unknown>
	if (!obj.name || typeof obj.name !== 'string') {
		throw new Error(`${filename}: missing or invalid 'name'`)
	}
	if (!obj.command || typeof obj.command !== 'string') {
		throw new Error(`${filename}: missing or invalid 'command'`)
	}

	let inputMode: 'stdin' | 'arg' | 'jsonl' = 'jsonl'
	if (obj.inputMode === 'arg') inputMode = 'arg'
	else if (obj.inputMode === 'stdin') inputMode = 'stdin'

	return {
		name: obj.name as string,
		command: obj.command as string,
		args: Array.isArray(obj.args) ? (obj.args as string[]) : [],
		inputMode,
		workingDirFlag: obj.workingDirFlag as string | undefined,
		resume: obj.resume as ResumeConfig | undefined,
		model: obj.model as ModelConfig | undefined,
	}
}

export const loadManifest = async (filePath: string): Promise<CLIManifest> => {
	const content = await readFile(filePath, 'utf-8')
	const data = parseYaml(content)
	return validateManifest(data, filePath)
}

export const loadAllManifests = async (
	adaptersDir: string
): Promise<Map<string, CLIManifest>> => {
	const manifests = new Map<string, CLIManifest>()

	let files: string[]
	try {
		files = await readdir(adaptersDir)
	} catch {
		return manifests
	}

	const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))

	for (const file of yamlFiles) {
		try {
			const manifest = await loadManifest(join(adaptersDir, file))
			if (!cliExists(manifest.command)) {
				console.warn(`Skipping adapter '${manifest.name}': CLI '${manifest.command}' not found`)
				continue
			}
			// Resolve to absolute path for reliable spawning
			const resolvedPath = resolveCommandPath(manifest.command)
			manifest.command = resolvedPath
			manifests.set(manifest.name, manifest)
			console.log(`Loaded adapter '${manifest.name}' (${resolvedPath})`)
		} catch (err) {
			console.error(`Failed to load manifest ${file}:`, err)
		}
	}

	return manifests
}
