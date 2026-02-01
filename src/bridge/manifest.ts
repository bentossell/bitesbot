import { execSync as childExecSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { log, logWarn, logError } from '../logging/file.js'

const expandHome = (path: string): string => {
	if (path.startsWith('~/')) {
		return join(homedir(), path.slice(2))
	}
	return path
}

type CliOverride = { key: string; value: string }

const resolveCliCommandOverride = (cliName: string): CliOverride | null => {
	const normalized = cliName.toUpperCase().replace(/[^A-Z0-9]/g, '_')
	const keyed = `TG_GATEWAY_CLI_${normalized}_BIN`
	const legacy = `TG_GATEWAY_${normalized}_BIN`
	const value = process.env[keyed] ?? process.env[legacy]
	if (!value) return null
	return { key: process.env[keyed] ? keyed : legacy, value }
}

/**
 * Common CLI installation directories to search.
 * Order matters - first match wins.
 */
const getCommonBinDirs = (): string[] => {
	const home = homedir()
	const dirs: string[] = []
	const seen = new Set<string>()
	const pushDir = (dir?: string) => {
		if (!dir) return
		const normalized = dir.replace(/\/+$/, '')
		if (!normalized || seen.has(normalized)) return
		seen.add(normalized)
		dirs.push(normalized)
	}

	// 0. Current PATH entries (if any)
	for (const dir of (process.env.PATH ?? '').split(':')) {
		pushDir(dir)
	}

	// 1. Factory CLI (droid)
	pushDir(join(home, '.factory', 'bin'))

	// 2. Bun global installs
	pushDir(join(home, '.bun', 'bin'))

	// 3. Claude CLI (Anthropic)
	pushDir(join(home, '.claude', 'bin'))

	// 4. User-local installs
	pushDir(join(home, '.local', 'bin'))
	pushDir(join(home, '.local', 'share', 'pnpm'))
	pushDir(join(home, 'Library', 'pnpm'))
	pushDir(process.env.PNPM_HOME)
	pushDir(process.env.NPM_CONFIG_PREFIX ? join(process.env.NPM_CONFIG_PREFIX, 'bin') : undefined)
	pushDir(process.env.YARN_GLOBAL_FOLDER ? join(process.env.YARN_GLOBAL_FOLDER, 'bin') : undefined)
	pushDir(join(home, '.yarn', 'bin'))
	pushDir(join(home, '.config', 'yarn', 'global', 'node_modules', '.bin'))
	pushDir(join(process.env.VOLTA_HOME ?? join(home, '.volta'), 'bin'))
	pushDir(join(process.env.ASDF_DIR ?? join(home, '.asdf'), 'shims'))

	// 5. NVM Node versions (scan all versions)
	const nvmDir = join(home, '.nvm', 'versions', 'node')
	try {
		for (const version of readdirSync(nvmDir).sort().reverse()) {
			pushDir(join(nvmDir, version, 'bin'))
		}
	} catch {
		// NVM not installed
	}

	// 6. FNM Node versions
	const fnmDir = process.env.FNM_DIR ?? join(home, '.fnm')
	const fnmVersionsDir = join(fnmDir, 'node-versions')
	try {
		for (const version of readdirSync(fnmVersionsDir).sort().reverse()) {
			pushDir(join(fnmVersionsDir, version, 'installation', 'bin'))
		}
	} catch {
		// FNM not installed
	}

	// 7. Homebrew (Apple Silicon and Intel)
	pushDir('/opt/homebrew/bin')
	pushDir('/opt/homebrew/sbin')
	pushDir('/usr/local/bin')
	pushDir('/usr/local/sbin')

	// 8. Global npm
	pushDir('/usr/local/lib/node_modules/.bin')
	pushDir('/opt/homebrew/lib/node_modules/.bin')

	// 9. Cargo (for Rust CLIs)
	pushDir(join(home, '.cargo', 'bin'))

	// 10. Go binaries
	pushDir(join(home, 'go', 'bin'))

	// 11. Standard system paths
	pushDir('/usr/bin')
	pushDir('/bin')
	pushDir('/usr/sbin')
	pushDir('/sbin')

	return dirs
}

/**
 * Search common installation directories for a command.
 * Returns the absolute path if found, null otherwise.
 */
const findCommandInCommonPaths = (command: string): string | null => {
	for (const dir of getCommonBinDirs()) {
		const candidate = join(dir, command)
		if (existsSync(candidate)) {
			return candidate
		}
	}
	return null
}

const cliExists = (command: string): boolean => {
	const expanded = expandHome(command)
	// Check if it's an absolute/relative path
	if (expanded.includes('/')) {
		return existsSync(expanded)
	}
	// Try which first (respects current PATH)
	try {
		childExecSync(`which ${command}`, { stdio: 'ignore' })
		return true
	} catch {
		// Fall back to searching common directories
		return Boolean(findCommandInCommonPaths(command))
	}
}

const resolveCommandPath = (command: string): string => {
	const expanded = expandHome(command)
	// If it's already a path, return expanded version
	if (expanded.includes('/')) {
		return expanded
	}
	// Try which first (respects current PATH)
	try {
		const result = childExecSync(`which ${command}`, { encoding: 'utf-8' })
		return result.trim()
	} catch {
		// Fall back to searching common directories
		return findCommandInCommonPaths(command) ?? command
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
			const override = resolveCliCommandOverride(manifest.name)
			if (override) {
				manifest.command = expandHome(override.value)
				log(`Using ${manifest.name} CLI override from ${override.key}: ${manifest.command}`)
			}
			if (!cliExists(manifest.command)) {
				logWarn(`Skipping adapter '${manifest.name}': CLI '${manifest.command}' not found`)
				continue
			}
			// Resolve to absolute path for reliable spawning
			const resolvedPath = resolveCommandPath(manifest.command)
			manifest.command = resolvedPath
			manifests.set(manifest.name, manifest)
			log(`Loaded adapter '${manifest.name}' (${resolvedPath})`)
		} catch (err) {
			logError(`Failed to load manifest ${file}:`, err)
		}
	}

	return manifests
}
