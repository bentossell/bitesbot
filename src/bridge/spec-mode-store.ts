/**
 * Spec mode state tracking per chat
 * Tracks whether a chat is in spec mode and stores the pending plan awaiting approval
 */

export type SpecModeState = {
	chatId: number | string
	active: boolean
	pendingPlan?: string
	originalTask: string
	cli: string
	createdAt: string
}

const specModeStates = new Map<string, SpecModeState>()

const makeKey = (chatId: number | string): string => String(chatId)

export const setSpecMode = (state: SpecModeState): void => {
	const key = makeKey(state.chatId)
	specModeStates.set(key, state)
}

export const getSpecMode = (chatId: number | string): SpecModeState | undefined => {
	return specModeStates.get(makeKey(chatId))
}

export const clearSpecMode = (chatId: number | string): void => {
	specModeStates.delete(makeKey(chatId))
}

export const isInSpecMode = (chatId: number | string): boolean => {
	const state = specModeStates.get(makeKey(chatId))
	return state?.active ?? false
}

export const setPendingPlan = (chatId: number | string, plan: string): void => {
	const state = specModeStates.get(makeKey(chatId))
	if (state) {
		state.pendingPlan = plan
		specModeStates.set(makeKey(chatId), state)
	}
}

export const getPendingSpecPlan = (chatId: number | string): string | undefined => {
	const state = specModeStates.get(makeKey(chatId))
	return state?.pendingPlan
}

// Natural language intent detection for approve/cancel
export const APPROVE_PATTERNS = /^(proceed|approved?|go ahead|looks good|lgtm|ship it|do it|yes|yep|execute|ok|okay|lets? go|start|begin|make it so|sounds good)$/i
export const CANCEL_PATTERNS = /^(cancel|stop|nevermind|never mind|abort|exit|no|nope|forget it|wait|hold|nah|dont|don't)$/i

export type IntentResult = 'approve' | 'cancel' | 'refine'

export const detectIntent = (text: string): IntentResult => {
	const trimmed = text.trim().toLowerCase()
	
	// Check for exact matches first
	if (APPROVE_PATTERNS.test(trimmed)) {
		return 'approve'
	}
	if (CANCEL_PATTERNS.test(trimmed)) {
		return 'cancel'
	}
	
	// If it's a short message (1-3 words) that doesn't match patterns, treat as refinement
	// If it's a longer message, definitely treat as refinement
	return 'refine'
}
