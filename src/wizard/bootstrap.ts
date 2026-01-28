import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CronJob, CronStore } from '../cron/types.js'
import { generateId, saveCronStore } from '../cron/store.js'
import type { GatewayConfig } from '../gateway/config.js'

export type WorkspaceBootstrapOptions = {
	workspacePath: string
	userName?: string
	timezone?: string
	quietHours?: string
	heartbeatSchedule?: string
	overwrite?: boolean
}

export type WorkspaceBootstrapResult = {
	workspacePath: string
	createdFiles: string[]
	skippedFiles: string[]
	createdDirectories: string[]
}

export type GatewayConfigInput = {
	botToken: string
	chatId?: string
	port?: number
	host?: string
	authToken?: string
	defaultCli: string
	workspacePath: string
	adaptersDir?: string
	configDir?: string
}

export type GatewayConfigResult = {
	configPath: string
}

export type CronConfigInput = {
	enabled: boolean
	cronExpr?: string
	timezone?: string
	configDir?: string
}

export type CronConfigResult = {
	cronPath: string
	jobId?: string
}

const DEFAULT_TEMPLATES: Record<string, string> = {
	'AGENTS.md': `# BitesBot Workspace\n\n- Follow instructions in USER.md and SOUL.md\n- Log sessions in sessions/\n- Keep long-term notes in MEMORY.md\n- Use TODOS.md for tasks\n`,
	'SOUL.md': `# BitesBot\n\n- Calm, concise responses\n- Ask clarifying questions when unsure\n- Respect quiet hours from USER.md\n`,
	'USER.md': `# User\n\nName: {{userName}}\nTimezone: {{timezone}}\nQuiet hours: {{quietHours}}\n`,
	'MEMORY.md': `# Memory\n\nLong-term notes go here.\n`,
	'HEARTBEAT.md': `# Heartbeat\n\nSchedule: {{heartbeatSchedule}}\n\nWhen triggered, check TODOS.md and MEMORY.md. Reply HEARTBEAT_OK when there is nothing to do.\n`,
	'TODOS.md': `# Todos\n\n- [ ] First task\n`,
}

const templateSearchPaths = () => {
	const cwdTemplates = join(process.cwd(), 'templates')
	const moduleDir = dirname(fileURLToPath(import.meta.url))
	const moduleTemplates = resolve(moduleDir, '../../templates')
	return [cwdTemplates, moduleTemplates]
}

const fileExists = async (path: string): Promise<boolean> => {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

const readTemplate = async (name: string): Promise<string> => {
	for (const base of templateSearchPaths()) {
		const candidate = join(base, name)
		if (await fileExists(candidate)) {
			return readFile(candidate, 'utf-8')
		}
	}
	return DEFAULT_TEMPLATES[name] ?? ''
}

const renderTemplate = (template: string, data: Record<string, string | undefined>): string => {
	return template.replace(/{{\s*(\w+)\s*}}/g, (_match, key) => data[key] ?? '')
}

const expandHome = (input: string): string => {
	if (input === '~') return homedir()
	if (input.startsWith('~/')) return join(homedir(), input.slice(2))
	return input
}

export const resolveWorkspacePath = (input: string): string => {
	const expanded = expandHome(input)
	if (isAbsolute(expanded)) return expanded
	return resolve(process.cwd(), expanded)
}

export const bootstrapWorkspace = async (options: WorkspaceBootstrapOptions): Promise<WorkspaceBootstrapResult> => {
	const workspacePath = resolveWorkspacePath(options.workspacePath)
	const createdFiles: string[] = []
	const skippedFiles: string[] = []
	const createdDirectories: string[] = []

	await mkdir(workspacePath, { recursive: true })

	const directories = ['memory', 'sessions', '.state']
	for (const dir of directories) {
		const fullPath = join(workspacePath, dir)
		await mkdir(fullPath, { recursive: true })
		createdDirectories.push(fullPath)
	}

	const templateData = {
		userName: options.userName ?? '',
		timezone: options.timezone ?? '',
		quietHours: options.quietHours ?? '',
		heartbeatSchedule: options.heartbeatSchedule ?? 'disabled',
	}

	const templateFiles = [
		'AGENTS.md',
		'SOUL.md',
		'USER.md',
		'MEMORY.md',
		'HEARTBEAT.md',
		'TODOS.md',
	]

	for (const file of templateFiles) {
		const targetPath = join(workspacePath, file)
		const exists = await fileExists(targetPath)
		if (exists && !options.overwrite) {
			skippedFiles.push(targetPath)
			continue
		}
		const template = await readTemplate(file)
		const rendered = renderTemplate(template, templateData)
		await writeFile(targetPath, rendered, 'utf-8')
		createdFiles.push(targetPath)
	}

	const today = new Date().toISOString().slice(0, 10)
	const dailyLogPath = join(workspacePath, 'memory', `${today}.md`)
	if (!(await fileExists(dailyLogPath)) || options.overwrite) {
		await writeFile(dailyLogPath, `# ${today}\n\n`, 'utf-8')
		createdFiles.push(dailyLogPath)
	}

	return { workspacePath, createdFiles, skippedFiles, createdDirectories }
}

const normalizeChatId = (input?: string): number | undefined => {
	if (!input) return undefined
	const parsed = Number(input)
	return Number.isNaN(parsed) ? undefined : parsed
}

export const writeGatewayConfig = async (input: GatewayConfigInput): Promise<GatewayConfigResult> => {
	const configDir = input.configDir ?? join(homedir(), '.config', 'tg-gateway')
	const configPath = join(configDir, 'config.json')
	const logsDir = join(configDir, 'logs')

	await mkdir(logsDir, { recursive: true })

	const allowedChatIds = input.chatId ? [normalizeChatId(input.chatId)].filter((id): id is number => id !== undefined) : undefined
	const adaptersDir = input.adaptersDir ?? join(process.cwd(), 'adapters')

	const payload: GatewayConfig = {
		botToken: input.botToken,
		host: input.host ?? '127.0.0.1',
		port: input.port ?? 8787,
		authToken: input.authToken,
		allowedChatIds: allowedChatIds?.length ? allowedChatIds : undefined,
		bridge: {
			enabled: true,
			defaultCli: input.defaultCli,
			workingDirectory: input.workspacePath,
			adaptersDir,
		},
	}

	await mkdir(dirname(configPath), { recursive: true })
	await writeFile(configPath, JSON.stringify(payload, null, 2), 'utf-8')

	return { configPath }
}

const buildHeartbeatJob = (expr: string, timezone?: string): CronJob => ({
	id: generateId(),
	name: 'Heartbeat',
	enabled: true,
	schedule: { kind: 'cron', expr, tz: timezone },
	message: 'Check HEARTBEAT.md and run any scheduled tasks. If nothing needs attention, reply HEARTBEAT_OK.',
	wakeMode: 'now',
	createdAtMs: Date.now(),
})

export const writeHeartbeatCronStore = async (input: CronConfigInput): Promise<CronConfigResult> => {
	const configDir = input.configDir ?? join(homedir(), '.config', 'tg-gateway')
	const cronPath = join(configDir, 'cron.json')
	let store: CronStore = { version: 1, jobs: [] }
	let jobId: string | undefined

	if (input.enabled && input.cronExpr) {
		const job = buildHeartbeatJob(input.cronExpr, input.timezone)
		jobId = job.id
		store = { version: 1, jobs: [job] }
	}

	await saveCronStore(cronPath, store)
	return { cronPath, jobId }
}

export const workspaceExists = async (workspacePath: string): Promise<boolean> => {
	try {
		const stats = await stat(workspacePath)
		return stats.isDirectory()
	} catch {
		return false
	}
}
