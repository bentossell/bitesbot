import { describe, it, expect, beforeEach } from 'vitest'
import {
	setSpecMode,
	getSpecMode,
	clearSpecMode,
	isInSpecMode,
	setPendingPlan,
	detectIntent,
} from '../src/bridge/spec-mode-store.js'

describe('spec-mode-store', () => {
	beforeEach(() => {
		clearSpecMode(123)
		clearSpecMode(456)
	})

	describe('setSpecMode / getSpecMode', () => {
		it('stores and retrieves spec mode state', () => {
			const state = {
				chatId: 123,
				active: true,
				originalTask: 'build a feature',
				cli: 'droid',
				createdAt: new Date().toISOString(),
			}
			setSpecMode(state)
			
			const retrieved = getSpecMode(123)
			expect(retrieved).toEqual(state)
		})

		it('returns undefined for non-existent chat', () => {
			expect(getSpecMode(999)).toBeUndefined()
		})

		it('tracks separate state per chat', () => {
			setSpecMode({ chatId: 123, active: true, originalTask: 'task1', cli: 'droid', createdAt: '' })
			setSpecMode({ chatId: 456, active: true, originalTask: 'task2', cli: 'claude', createdAt: '' })
			
			expect(getSpecMode(123)?.originalTask).toBe('task1')
			expect(getSpecMode(456)?.originalTask).toBe('task2')
		})
	})

	describe('clearSpecMode', () => {
		it('removes spec mode state', () => {
			setSpecMode({ chatId: 123, active: true, originalTask: 'task', cli: 'droid', createdAt: '' })
			expect(getSpecMode(123)).toBeDefined()
			
			clearSpecMode(123)
			expect(getSpecMode(123)).toBeUndefined()
		})

		it('does nothing for non-existent chat', () => {
			clearSpecMode(999) // should not throw
		})
	})

	describe('isInSpecMode', () => {
		it('returns true when spec mode is active', () => {
			setSpecMode({ chatId: 123, active: true, originalTask: 'task', cli: 'droid', createdAt: '' })
			expect(isInSpecMode(123)).toBe(true)
		})

		it('returns false when no spec mode', () => {
			expect(isInSpecMode(123)).toBe(false)
		})

		it('returns false when spec mode was cleared', () => {
			setSpecMode({ chatId: 123, active: true, originalTask: 'task', cli: 'droid', createdAt: '' })
			clearSpecMode(123)
			expect(isInSpecMode(123)).toBe(false)
		})
	})

	describe('setPendingPlan', () => {
		it('adds pending plan to existing spec state', () => {
			setSpecMode({ chatId: 123, active: true, originalTask: 'task', cli: 'droid', createdAt: '' })
			setPendingPlan(123, 'Here is the plan...')
			
			const state = getSpecMode(123)
			expect(state?.pendingPlan).toBe('Here is the plan...')
		})

		it('does nothing if no spec state exists', () => {
			setPendingPlan(123, 'plan')
			expect(getSpecMode(123)).toBeUndefined()
		})
	})

	describe('detectIntent', () => {
		it('detects approval intents (exact matches)', () => {
			expect(detectIntent('yes')).toBe('approve')
			expect(detectIntent('Yes')).toBe('approve')
			expect(detectIntent('proceed')).toBe('approve')
			expect(detectIntent('go ahead')).toBe('approve')
			expect(detectIntent('approved')).toBe('approve')
			expect(detectIntent('looks good')).toBe('approve')
			expect(detectIntent('lgtm')).toBe('approve')
			expect(detectIntent('LGTM')).toBe('approve')
			expect(detectIntent('do it')).toBe('approve')
			expect(detectIntent('ok')).toBe('approve')
			expect(detectIntent('OK')).toBe('approve')
			expect(detectIntent('okay')).toBe('approve')
			expect(detectIntent('sounds good')).toBe('approve')
			expect(detectIntent('lets go')).toBe('approve')
			expect(detectIntent('ship it')).toBe('approve')
		})

		it('detects cancel intents (exact matches)', () => {
			expect(detectIntent('cancel')).toBe('cancel')
			expect(detectIntent('Cancel')).toBe('cancel')
			expect(detectIntent('stop')).toBe('cancel')
			expect(detectIntent('abort')).toBe('cancel')
			expect(detectIntent('nevermind')).toBe('cancel')
			expect(detectIntent('never mind')).toBe('cancel')
			expect(detectIntent('no')).toBe('cancel')
			expect(detectIntent('nope')).toBe('cancel')
			expect(detectIntent('forget it')).toBe('cancel')
		})
		
		it('treats partial matches as refine', () => {
			expect(detectIntent('Proceed with it')).toBe('refine')
			expect(detectIntent('No thanks')).toBe('refine')
			expect(detectIntent('yes please')).toBe('refine')
		})

		it('returns refine for other text', () => {
			expect(detectIntent('Can you also add tests?')).toBe('refine')
			expect(detectIntent('What about error handling?')).toBe('refine')
			expect(detectIntent('I think we should do it differently')).toBe('refine')
		})

		it('handles whitespace', () => {
			expect(detectIntent('  yes  ')).toBe('approve')
			expect(detectIntent('\ncancel\n')).toBe('cancel')
		})
	})
})
