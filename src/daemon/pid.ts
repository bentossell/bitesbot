import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const resolvePidPath = () => join(homedir(), '.config', 'tg-gateway', 'tg-gateway.pid')

export const writePidFile = async (pid: number) => {
	const pidPath = resolvePidPath()
	await mkdir(dirname(pidPath), { recursive: true })
	await writeFile(pidPath, String(pid), 'utf-8')
	return pidPath
}

export const readPidFile = async () => {
	const pidPath = resolvePidPath()
	const raw = await readFile(pidPath, 'utf-8')
	return { pid: Number(raw.trim()), pidPath }
}

export const removePidFile = async () => {
	const pidPath = resolvePidPath()
	await unlink(pidPath)
}
