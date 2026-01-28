export type PlanStep = {
	id: number
	description: string
	files?: string[]
}

export type Plan = {
	title: string
	steps: PlanStep[]
	estimatedCost?: number
	risks?: string[]
}

export type PlanApprovalState = {
	chatId: number | string
	plan: Plan
	originalPrompt: string
	cli: string
	messageId?: number
	userId?: number | string
	createdAt: string // ISO string for serialization
}
