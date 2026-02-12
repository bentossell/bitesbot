import { Bot } from 'grammy'
import { wizardSteps, type WizardField, type WizardStepId } from './steps.js'
import type { WizardData } from './session.js'

export type WizardValidationResult = {
	ok: boolean
	missing: string[]
}

export type WizardTestResult = {
	ok: boolean
	bot?: {
		id: number
		username?: string
		firstName?: string
	}
	error?: string
}

const baseRequiredFields = (stepId: WizardStepId): WizardField[] => {
	const step = wizardSteps.find((item) => item.id === stepId)
	if (!step || !step.fields) return []
	return step.fields.filter((field) => field.required)
}

const isFilled = (value: unknown): boolean => {
	if (typeof value === 'string') return value.trim().length > 0
	if (typeof value === 'number') return !Number.isNaN(value)
	if (typeof value === 'boolean') return true
	return value !== undefined && value !== null
}

export const applyWizardDefaults = (data: WizardData): WizardData => ({
	agentType: data.agentType ?? 'claude',
	workspacePath: data.workspacePath ?? '~/bites',
	heartbeatEnabled: data.heartbeatEnabled ?? false,
	heartbeatCron: data.heartbeatCron ?? '0 9 * * *',
	installDaemon: data.installDaemon ?? false,
	...data,
})

export const validateWizardStep = (stepId: WizardStepId, data: WizardData): WizardValidationResult => {
	const missing: string[] = []
	const requiredFields = baseRequiredFields(stepId)

	for (const field of requiredFields) {
		const value = data[field.key as keyof WizardData]
		if (!isFilled(value)) {
			missing.push(field.key)
		}
	}

	if (stepId === 'agent' && data.agentType === 'custom') {
		if (!isFilled(data.customAdapterName)) missing.push('customAdapterName')
		if (!isFilled(data.customAdaptersDir)) missing.push('customAdaptersDir')
	}

	if (stepId === 'heartbeat' && data.heartbeatEnabled) {
		if (!isFilled(data.heartbeatCron)) missing.push('heartbeatCron')
	}

	return { ok: missing.length === 0, missing }
}

export const testTelegramConnection = async (botToken: string, chatId?: string): Promise<WizardTestResult> => {
	try {
		const bot = new Bot(botToken)
		const me = await bot.api.getMe()
		if (chatId) {
			const parsed = Number(chatId)
			const target = Number.isNaN(parsed) ? chatId : parsed
			await bot.api.sendChatAction(target, 'typing')
		}
		return {
			ok: true,
			bot: {
				id: me.id,
				username: me.username,
				firstName: me.first_name,
			},
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'unknown error'
		return { ok: false, error: message }
	}
}
