import { randomUUID } from 'node:crypto'
import { wizardStepOrder, type WizardStepId } from './steps.js'

export type AgentType = 'claude' | 'droid' | 'custom'

export type WizardData = {
	botToken?: string
	chatId?: string
	agentType?: AgentType
	customAdapterName?: string
	customAdaptersDir?: string
	workspacePath?: string
	userName?: string
	timezone?: string
	quietHours?: string
	heartbeatEnabled?: boolean
	heartbeatCron?: string
	installDaemon?: boolean
}

export type WizardSessionSnapshot = {
	id: string
	stepIndex: number
	stepId: WizardStepId
	data: WizardData
	createdAt: string
	updatedAt: string
	isComplete: boolean
}

const resolveStepIndex = (stepId?: WizardStepId) => {
	if (!stepId) return 0
	const idx = wizardStepOrder.indexOf(stepId)
	return idx === -1 ? 0 : idx
}

export class WizardSession {
	readonly id: string
	private stepIndex = 0
	data: WizardData
	private createdAt: Date
	private updatedAt: Date

	constructor(options: { id?: string; stepId?: WizardStepId; data?: WizardData } = {}) {
		this.id = options.id ?? randomUUID()
		this.stepIndex = resolveStepIndex(options.stepId)
		this.data = options.data ?? {}
		this.createdAt = new Date()
		this.updatedAt = new Date()
	}

	get stepId(): WizardStepId {
		return wizardStepOrder[this.stepIndex] ?? wizardStepOrder[0]
	}

	get isComplete(): boolean {
		return this.stepIndex >= wizardStepOrder.length - 1
	}

	update(patch: WizardData): void {
		this.data = { ...this.data, ...patch }
		this.touch()
	}

	setStep(stepId: WizardStepId): boolean {
		const idx = wizardStepOrder.indexOf(stepId)
		if (idx === -1) return false
		this.stepIndex = idx
		this.touch()
		return true
	}

	next(): boolean {
		if (this.stepIndex >= wizardStepOrder.length - 1) return false
		this.stepIndex += 1
		this.touch()
		return true
	}

	prev(): boolean {
		if (this.stepIndex <= 0) return false
		this.stepIndex -= 1
		this.touch()
		return true
	}

	snapshot(): WizardSessionSnapshot {
		return {
			id: this.id,
			stepIndex: this.stepIndex,
			stepId: this.stepId,
			data: this.data,
			createdAt: this.createdAt.toISOString(),
			updatedAt: this.updatedAt.toISOString(),
			isComplete: this.isComplete,
		}
	}

	private touch(): void {
		this.updatedAt = new Date()
	}
}
