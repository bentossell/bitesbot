#!/usr/bin/env node
import { Command } from 'commander'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { readPidFile } from './pid.js'
import { runGateway } from './run.js'

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
		try {
			const { pid, pidPath } = await readPidFile()
			process.kill(pid, 'SIGTERM')
			process.stdout.write(`stopped (pid ${pid}) from ${pidPath}\n`)
		} catch {
			process.stdout.write('no running gateway found\n')
		}
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

program.parseAsync(process.argv)
