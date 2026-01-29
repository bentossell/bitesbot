import { describe, it, expect } from 'vitest'
import {
	storePendingPlan,
	getPendingPlan,
	removePendingPlan,
} from '../src/bridge/plan-approval-store.js'

describe('plan-approval-store', () => {
	it('keys pending plans by chatId + messageId + userId', () => {
		const state = {
			chatId: 1,
			plan: { title: 'Plan', steps: [{ id: 1, description: 'Do thing' }] },
			originalPrompt: 'Do thing',
			cli: 'claude',
			messageId: 42,
			userId: 7,
			createdAt: new Date().toISOString(),
		}

		storePendingPlan(state)

		const exact = getPendingPlan(1, 42, 7)
		expect(exact?.messageId).toBe(42)

		const wrongMessage = getPendingPlan(1, 43, 7)
		expect(wrongMessage).toBeUndefined()

		removePendingPlan(1, 42, 7)
		const removed = getPendingPlan(1, 42, 7)
		expect(removed).toBeUndefined()
	})
})
