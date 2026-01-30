#!/usr/bin/env node
import { Command } from 'commander'
import { execFileSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { readPidFile } from './pid.js'
import { runGateway } from './run.js'

const expandHome = (path: string): string => {
	if (path.startsWith('~/')) {
		return join(homedir(), path.slice(2))
	}
	return path
}

const resolveLaunchdLabel = (label?: string): string =>
	label ?? process.env.TG_GATEWAY_LAUNCHD_LABEL ?? 'com.bentossell.bitesbot'

const resolveLaunchdPlist = (plist?: string, label?: string): string => {
	const resolvedLabel = resolveLaunchdLabel(label)
	const defaultPlist = join(homedir(), 'Library', 'LaunchAgents', `${resolvedLabel}.plist`)
	return expandHome(plist ?? process.env.TG_GATEWAY_LAUNCHD_PLIST ?? defaultPlist)
}

const isLaunchdEnv = (): boolean => {
	const flag = process.env.TG_GATEWAY_LAUNCHD?.toLowerCase()
	if (flag && ['1', 'true', 'yes'].includes(flag)) return true
	return Boolean(process.env.TG_GATEWAY_LAUNCHD_LABEL || process.env.TG_GATEWAY_LAUNCHD_PLIST)
}

const ensureDarwin = () => {
	if (process.platform !== 'darwin') {
		process.stdout.write('launchd commands are only supported on macOS\n')
		process.exit(1)
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const stopGateway = async () => {
	try {
		const { pid, pidPath } = await readPidFile()
		process.kill(pid, 'SIGTERM')
		return { stopped: true, pid, pidPath }
	} catch {
		return { stopped: false }
	}
}

const program = new Command()
program.name('tg-gateway').description('Portable Telegram gateway for CLI agents').version('0.1.0')

program
	.command('start')
	.option('-c, --config <path>', 'config file path')
	.option('--daemon', 'run in background')
	.option('--child', 'internal flag for daemon child process')
	.action(async (options) => {
		if (options.daemon && !options.child) {
			const args = process.argv.slice(2).filter((arg) => arg !== '--daemon')
			args.push('--child')
			const child = spawn(process.execPath, [process.argv[1], ...args], {
				detached: true,
				stdio: 'ignore',
			})
			child.unref()
			return
		}

		await runGateway({ configPath: options.config })
		process.stdout.write('tg-gateway running\n')
	})

program
	.command('stop')
	.action(async () => {
		const result = await stopGateway()
		if (result.stopped) {
			process.stdout.write(`stopped (pid ${result.pid}) from ${result.pidPath}\n`)
			return
		}
		process.stdout.write('no running gateway found\n')
	})

program
	.command('status')
	.action(async () => {
		try {
			const { pid } = await readPidFile()
			process.kill(pid, 0)
			process.stdout.write(`running (pid ${pid})\n`)
		} catch {
			process.stdout.write('not running\n')
		}
	})

program
	.command('restart')
	.option('-c, --config <path>', 'config file path')
	.option('--label <label>', 'launchd label')
	.option('--plist <path>', 'launchd plist path')
	.action(async (options) => {
		if (isLaunchdEnv()) {
			ensureDarwin()
			const label = resolveLaunchdLabel(options.label)
			const plist = resolveLaunchdPlist(options.plist, label)
			try {
				execFileSync('launchctl', ['unload', plist], { stdio: 'inherit' })
			} catch {
				process.stdout.write(`launchd unload failed (${label})\n`)
				process.exitCode = 1
				return
			}
			try {
				execFileSync('launchctl', ['load', plist], { stdio: 'inherit' })
				process.stdout.write(`launchd restarted (${label})\n`)
			} catch {
				process.stdout.write(`launchd load failed (${label})\n`)
				process.exitCode = 1
			}
			return
		}

		await stopGateway()
		await sleep(2000)
		const args = ['start', '--daemon']
		if (options.config) {
			args.push('--config', options.config)
		}
		try {
			execFileSync(process.execPath, [process.argv[1], ...args], { stdio: 'ignore' })
			process.stdout.write('restarted\n')
		} catch {
			process.stdout.write('restart failed\n')
			process.exitCode = 1
		}
	})

program
	.command('launchd-start')
	.option('--label <label>', 'launchd label')
	.option('--plist <path>', 'launchd plist path')
	.action((options) => {
		ensureDarwin()
		const label = resolveLaunchdLabel(options.label)
		const plist = resolveLaunchdPlist(options.plist, label)
		try {
			execFileSync('launchctl', ['load', plist], { stdio: 'inherit' })
			process.stdout.write(`launchd loaded (${label})\n`)
		} catch {
			process.stdout.write(`launchd load failed (${label})\n`)
			process.exitCode = 1
		}
	})

program
	.command('launchd-stop')
	.option('--label <label>', 'launchd label')
	.option('--plist <path>', 'launchd plist path')
	.action((options) => {
		ensureDarwin()
		const label = resolveLaunchdLabel(options.label)
		const plist = resolveLaunchdPlist(options.plist, label)
		try {
			execFileSync('launchctl', ['unload', plist], { stdio: 'inherit' })
			process.stdout.write(`launchd unloaded (${label})\n`)
		} catch {
			process.stdout.write(`launchd unload failed (${label})\n`)
			process.exitCode = 1
		}
	})

program
	.command('launchd-status')
	.option('--label <label>', 'launchd label')
	.action((options) => {
		ensureDarwin()
		const label = resolveLaunchdLabel(options.label)
		try {
			execFileSync('launchctl', ['list', label], { stdio: 'ignore' })
			process.stdout.write(`launchd running (${label})\n`)
		} catch {
			process.stdout.write(`launchd not running (${label})\n`)
			process.exitCode = 1
		}
	})

program
	.command('launchd-restart')
	.option('--label <label>', 'launchd label')
	.option('--plist <path>', 'launchd plist path')
	.action((options) => {
		ensureDarwin()
		const label = resolveLaunchdLabel(options.label)
		const plist = resolveLaunchdPlist(options.plist, label)
		try {
			execFileSync('launchctl', ['unload', plist], { stdio: 'inherit' })
		} catch {
			process.stdout.write(`launchd unload failed (${label})\n`)
			process.exitCode = 1
			return
		}
		try {
			execFileSync('launchctl', ['load', plist], { stdio: 'inherit' })
			process.stdout.write(`launchd restarted (${label})\n`)
		} catch {
			process.stdout.write(`launchd load failed (${label})\n`)
			process.exitCode = 1
		}
	})

program.parseAsync(process.argv)
