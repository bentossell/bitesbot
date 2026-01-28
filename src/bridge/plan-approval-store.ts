import type { Plan, PlanApprovalState } from '../protocol/plan-types.js'

const pendingApprovals = new Map<string, PlanApprovalState>()

export const storePendingPlan = (state: PlanApprovalState): void => {
	const key = String(state.chatId)
	pendingApprovals.set(key, state)
}

export const getPendingPlan = (chatId: number | string): PlanApprovalState | undefined => {
	const key = String(chatId)
	return pendingApprovals.get(key)
}

export const removePendingPlan = (chatId: number | string): void => {
	const key = String(chatId)
	pendingApprovals.delete(key)
}

export const formatPlanForDisplay = (plan: Plan): string => {
	const lines = [`📋 **${plan.title}**\n`]

	for (const step of plan.steps) {
		lines.push(`${step.id}. ${step.description}`)
		if (step.files && step.files.length > 0) {
			lines.push(`   Files: ${step.files.join(', ')}`)
		}
	}

	if (plan.risks && plan.risks.length > 0) {
		lines.push('\n⚠️ **Risks:**')
		for (const risk of plan.risks) {
			lines.push(`• ${risk}`)
		}
	}

	if (plan.estimatedCost) {
		lines.push(`\n💰 Estimated cost: $${plan.estimatedCost.toFixed(2)}`)
	}

	return lines.join('\n')
}
