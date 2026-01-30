import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Skill, SkillDirectories, SkillMetadata } from './types.js'

export const getDefaultSkillDirectories = (workingDirectory?: string): SkillDirectories => ({
	personal: join(homedir(), 'skills'),
	factory: join(homedir(), '.factory', 'skills'),
	claude: join(homedir(), '.claude', 'skills'),
	workspace: workingDirectory ? join(workingDirectory, 'skills') : undefined,
})

const binExists = (name: string): boolean => {
	try {
		execSync(`which ${name}`, { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

const envExists = (name: string): boolean =>
	process.env[name] !== undefined && process.env[name] !== ''

export const parseFrontmatter = (content: string): SkillMetadata | null => {
	const match = content.match(/^---\n([\s\S]*?)\n---/)
	if (!match) return null
	try {
		const data = parseYaml(match[1]) as Record<string, unknown>
		if (!data.name || typeof data.name !== 'string') return null
		return {
			name: data.name,
			description: typeof data.description === 'string' ? data.description : undefined,
			requires: Array.isArray(data.requires) ? (data.requires as SkillMetadata['requires']) : undefined,
			platforms: Array.isArray(data.platforms) ? (data.platforms as SkillMetadata['platforms']) : undefined,
		}
	} catch {
		return null
	}
}

export const checkRequirements = (metadata: SkillMetadata): { available: boolean; reason?: string } => {
	if (metadata.platforms?.length) {
		const cur = platform() as 'darwin' | 'linux' | 'win32'
		if (!metadata.platforms.includes(cur))
			return { available: false, reason: `Requires platform: ${metadata.platforms.join(', ')}` }
	}
	if (metadata.requires) {
		for (const req of metadata.requires) {
			if ('bin' in req && !binExists(req.bin))
				return { available: false, reason: `Requires binary: ${req.bin}` }
			if ('env' in req && !envExists(req.env))
				return { available: false, reason: `Requires env: ${req.env}` }
		}
	}
	return { available: true }
}

export const loadSkill = async (skillDir: string, source: Skill['source']): Promise<Skill | null> => {
	const skillMdPath = join(skillDir, 'SKILL.md')
	if (!existsSync(skillMdPath)) return null
	try {
		const content = await readFile(skillMdPath, 'utf-8')
		const metadata = parseFrontmatter(content)
		const name = metadata?.name ?? skillDir.split('/').pop() ?? 'unknown'
		const { available, reason } = metadata ? checkRequirements(metadata) : { available: true }
		return { name, description: metadata?.description, path: skillMdPath, source, available, unavailableReason: reason }
	} catch {
		return null
	}
}

export const scanDirectory = async (dir: string, source: Skill['source']): Promise<Skill[]> => {
	if (!existsSync(dir)) return []
	const skills: Skill[] = []
	try {
		const entries = await readdir(dir, { withFileTypes: true })
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			const skill = await loadSkill(join(dir, entry.name), source)
			if (skill) skills.push(skill)
		}
	} catch { /* ignore */ }
	return skills
}

export const scanAllSkills = async (directories: SkillDirectories): Promise<Map<string, Skill>> => {
	const skillMap = new Map<string, Skill>()
	const sources: Array<{ dir?: string; source: Skill['source'] }> = [
		{ dir: directories.personal, source: 'personal' },
		{ dir: directories.factory, source: 'factory' },
		{ dir: directories.claude, source: 'claude' },
		{ dir: directories.workspace, source: 'workspace' },
	]
	for (const { dir, source } of sources) {
		if (!dir) continue
		for (const skill of await scanDirectory(dir, source))
			skillMap.set(skill.name, skill)
	}
	return skillMap
}

export const formatSkillList = (skills: Map<string, Skill>): string => {
	if (skills.size === 0) return 'No skills found.'
	const lines: string[] = ['Available skills:']
	const unavailable: string[] = []
	for (const skill of skills.values()) {
		const desc = skill.description ? ` - ${skill.description}` : ''
		if (skill.available) {
			lines.push(`• ${skill.name}${desc}`)
			lines.push(`  (${skill.path.replace(homedir(), '~')})`)
		} else {
			unavailable.push(`• ${skill.name}${desc}`)
			unavailable.push(`  ⚠️ ${skill.unavailableReason}`)
		}
	}
	if (unavailable.length) lines.push('', 'Unavailable skills:', ...unavailable)
	return lines.join('\n')
}

export const formatSkillInfo = (skill: Skill): string => {
	const lines = [`📚 ${skill.name}`]
	if (skill.description) lines.push(skill.description)
	lines.push('', `Source: ${skill.source}`, `Path: ${skill.path.replace(homedir(), '~')}`)
	if (!skill.available) lines.push('', `⚠️ ${skill.unavailableReason}`)
	lines.push('', 'To use this skill, read its SKILL.md and follow the instructions.')
	return lines.join('\n')
}

export const buildSkillContext = (skills: Map<string, Skill>): string | null => {
	const available = Array.from(skills.values()).filter(s => s.available)
	if (!available.length) return null
	const lines = ['Available skills:']
	for (const skill of available) {
		const desc = skill.description ? `: ${skill.description}` : ''
		lines.push(`- ${skill.name}${desc} (${skill.path.replace(homedir(), '~')})`)
	}
	lines.push('', 'To use a skill, read its SKILL.md and follow the instructions.')
	return lines.join('\n')
}
