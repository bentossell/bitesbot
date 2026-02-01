import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CronJob, CronStore } from './types.js'

const DEFAULT_STORE: CronStore = { version: 1, jobs: [] }

export const loadCronStore = async (path: string): Promise<CronStore> => {
	try {
		const data = await readFile(path, 'utf-8')
		return JSON.parse(data) as CronStore
	} catch {
		return { ...DEFAULT_STORE }
	}
}

export const saveCronStore = async (path: string, store: CronStore): Promise<void> => {
	await mkdir(dirname(path), { recursive: true })
	const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
	const json = JSON.stringify(store, null, 2)
	await writeFile(tmp, json, 'utf-8')
	try {
		await rename(tmp, path)
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | null)?.code
		if (code !== 'ENOENT') throw err
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, json, 'utf-8')
	}
	try {
		await copyFile(path, `${path}.bak`)
	} catch {
		// best-effort
	}
}

export const generateId = (): string => {
	return Math.random().toString(36).slice(2, 10)
}

export const findJob = (store: CronStore, id: string): CronJob | undefined => {
	return store.jobs.find((j) => j.id === id)
}

export const updateJob = (store: CronStore, id: string, patch: Partial<CronJob>): CronStore => {
	return {
		...store,
		jobs: store.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
	}
}

export const removeJob = (store: CronStore, id: string): CronStore => {
	return {
		...store,
		jobs: store.jobs.filter((j) => j.id !== id),
	}
}

export const addJob = (store: CronStore, job: CronJob): CronStore => {
	return {
		...store,
		jobs: [...store.jobs, job],
	}
}
