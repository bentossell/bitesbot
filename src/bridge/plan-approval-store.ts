import type { Plan, PlanApprovalState } from '../protocol/plan-types.js'

const pendingApprovals = new Map<string, PlanApprovalState>()

// Generate a unique key that includes chatId and optional messageId/userId
// This ensures approvals are tied to specific messages and users
const makeKey = (chatId: number | string, messageId?: number, userId?: number | string): string => {
	// Base key is chatId - for looking up pending plans by chat
	const parts = [String(chatId)]
	// Include messageId if provided to distinguish multiple pending plans
	if (messageId !== undefined) {
		parts.push(String(messageId))
	}
	// Include userId if provided for user-specific validation
	if (userId !== undefined) {
		parts.push(String(userId))
	}
	return parts.join(':')
}

export const storePendingPlan = (state: PlanApprovalState): void => {
	// Store by chat+user to prevent cross-user approval
	const key = makeKey(state.chatId, state.messageId, state.userId)
	pendingApprovals.set(key, state)
}

export const getPendingPlan = (chatId: number | string, messageId?: number, userId?: number | string): PlanApprovalState | undefined => {
	// Try exact match first (with userId)
	if (userId !== undefined) {
		const exactKey = makeKey(chatId, messageId, userId)
		const exact = pendingApprovals.get(exactKey)
		if (exact) return exact
		// Fallback to chat+user key if messageId was not stored
		const userKey = makeKey(chatId, undefined, userId)
		const userMatch = pendingApprovals.get(userKey)
		if (userMatch) return userMatch
	}
	// Fall back to chat-only key for backward compatibility
	const fallbackKey = String(chatId)
	return pendingApprovals.get(fallbackKey)
}

export const removePendingPlan = (chatId: number | string, messageId?: number, userId?: number | string): void => {
	// Remove by exact key first
	if (userId !== undefined) {
		const exactKey = makeKey(chatId, messageId, userId)
		if (pendingApprovals.has(exactKey)) {
			pendingApprovals.delete(exactKey)
			return
		}
		// Remove chat+user key if present
		const userKey = makeKey(chatId, undefined, userId)
		if (pendingApprovals.has(userKey)) {
			pendingApprovals.delete(userKey)
			return
		}
	}
	// Fall back to chat-only key
	const fallbackKey = String(chatId)
	pendingApprovals.delete(fallbackKey)
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
