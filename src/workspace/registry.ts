import { readFile, writeFile, mkdir, readdir, stat, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export type WorkspaceInfo = { id: string; name: string; path: string; description?: string; createdAt: number; lastUsedAt: number }
export type WorkspaceConfig = { default: string; registry: Record<string, { path: string; name: string; description?: string }> }
type WorkspaceRegistryState = { version: 1; activeWorkspace: Record<string, string>; lastUsedAt: Record<string, number> }

const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'tg-gateway')
const WORKSPACE_STATE_PATH = join(DEFAULT_CONFIG_DIR, 'workspace-state.json')
const WORKSPACE_MARKER_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md']

export const isWorkspaceDir = async (dirPath: string): Promise<boolean> => {
	for (const marker of WORKSPACE_MARKER_FILES) { try { await access(join(dirPath, marker)); return true } catch { /* continue */ } }
	return false
}

export const discoverWorkspaces = async (): Promise<Map<string, WorkspaceInfo>> => {
	const discovered = new Map<string, WorkspaceInfo>()
	try {
		const entries = await readdir(join(homedir(), 'workspaces'), { withFileTypes: true })
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			const dirPath = join(homedir(), 'workspaces', entry.name)
			if (await isWorkspaceDir(dirPath)) {
				const stats = await stat(dirPath)
				discovered.set(entry.name, { id: entry.name, name: entry.name, path: dirPath, createdAt: stats.birthtimeMs, lastUsedAt: stats.mtimeMs })
			}
		}
	} catch { /* ~/workspaces/ doesn't exist */ }
	return discovered
}

const expandPath = (p: string): string => p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p)
const loadState = async (): Promise<WorkspaceRegistryState> => { try { return JSON.parse(await readFile(WORKSPACE_STATE_PATH, 'utf-8')) } catch { return { version: 1, activeWorkspace: {}, lastUsedAt: {} } } }
const saveState = async (state: WorkspaceRegistryState): Promise<void> => { await mkdir(dirname(WORKSPACE_STATE_PATH), { recursive: true }); await writeFile(WORKSPACE_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8') }

export type WorkspaceRegistry = { list: () => WorkspaceInfo[]; get: (id: string) => WorkspaceInfo | undefined; getDefault: () => string; getActive: (chatId: number | string) => WorkspaceInfo | undefined; setActive: (chatId: number | string, workspaceId: string) => Promise<boolean>; clearActive: (chatId: number | string) => Promise<void>; touch: (workspaceId: string) => Promise<void>; reload: () => Promise<void> }
export type CreateWorkspaceRegistryOptions = { config?: WorkspaceConfig; defaultWorkingDir?: string }

export const createWorkspaceRegistry = async (options: CreateWorkspaceRegistryOptions = {}): Promise<WorkspaceRegistry> => {
	const workspaces = new Map<string, WorkspaceInfo>()
	let defaultWorkspace = 'default'
	const state = await loadState()
	const reload = async () => {
		workspaces.clear()
		if (options.config?.registry) {
			for (const [id, info] of Object.entries(options.config.registry)) { workspaces.set(id, { id, name: info.name, path: expandPath(info.path), description: info.description, createdAt: state.lastUsedAt[id] || Date.now(), lastUsedAt: state.lastUsedAt[id] || Date.now() }) }
			defaultWorkspace = options.config.default || 'default'
		}
		for (const [id, info] of await discoverWorkspaces()) { if (!workspaces.has(id)) workspaces.set(id, { ...info, lastUsedAt: state.lastUsedAt[id] || info.lastUsedAt }) }
		if (!workspaces.has(defaultWorkspace)) { workspaces.set('default', { id: 'default', name: 'Default', path: options.defaultWorkingDir || process.cwd(), createdAt: Date.now(), lastUsedAt: Date.now() }); defaultWorkspace = 'default' }
	}
	await reload()
	return {
		list: () => Array.from(workspaces.values()).sort((a, b) => b.lastUsedAt - a.lastUsedAt),
		get: (id) => workspaces.get(id), getDefault: () => defaultWorkspace,
		getActive: (chatId) => workspaces.get(state.activeWorkspace[String(chatId)]) || workspaces.get(defaultWorkspace),
		setActive: async (chatId, workspaceId) => { if (!workspaces.has(workspaceId)) return false; state.activeWorkspace[String(chatId)] = workspaceId; state.lastUsedAt[workspaceId] = Date.now(); await saveState(state); return true },
		clearActive: async (chatId) => { delete state.activeWorkspace[String(chatId)]; await saveState(state) },
		touch: async (workspaceId) => { if (workspaces.has(workspaceId)) { state.lastUsedAt[workspaceId] = Date.now(); await saveState(state) } },
		reload,
	}
}

export const formatWorkspaceList = (workspaces: WorkspaceInfo[], activeId?: string, defaultId?: string): string => {
	if (workspaces.length === 0) return 'No workspaces configured.'
	const lines = ['Workspaces:']
	for (const ws of workspaces) {
		const markers = [ws.id === activeId && 'active', ws.id === defaultId && 'default'].filter(Boolean)
		lines.push('  ' + ws.id + ': ' + ws.name + (markers.length ? ' (' + markers.join(', ') + ')' : ''))
		if (ws.description) lines.push('    ' + ws.description)
	}
	return lines.join('\n')
}
