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
	// Remove exact key first
	const key = makeKey(chatId, messageId, userId)
	pendingApprovals.delete(key)
	// Also remove fallback key if messageId/userId not provided
	if (messageId === undefined && userId === undefined) {
		pendingApprovals.delete(String(chatId))
	}
}

export const formatPlanForDisplay = (plan: Plan): string => {
	const lines: string[] = []
	lines.push(`📝 ${plan.title}`)
	lines.push('')
	lines.push('Steps:')
	for (const step of plan.steps) {
		const files = step.files && step.files.length > 0 ? ` [Files: ${step.files.join(', ')}]` : ''
		lines.push(`${step.id}. ${step.description}${files}`)
	}
	if (plan.risks && plan.risks.length > 0) {
		lines.push('')
		lines.push('Risks:')
		for (const risk of plan.risks) {
			lines.push(`- ${risk}`)
		}
	}
	return lines.join('\n')
}
