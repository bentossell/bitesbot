export enum CommandLane {
	Main = 'main',
	Subagent = 'subagent',
	Cron = 'cron',
}

type QueueEntry = {
	task: () => Promise<unknown>
	resolve: (value: unknown) => void
	reject: (reason?: unknown) => void
	enqueuedAt: number
}

type LaneState = {
	lane: string
	queue: QueueEntry[]
	active: number
	maxConcurrent: number
	draining: boolean
}

const lanes = new Map<string, LaneState>()

function getLaneState(lane: string): LaneState {
	const existing = lanes.get(lane)
	if (existing) return existing
	const created: LaneState = {
		lane,
		queue: [],
		active: 0,
		maxConcurrent: 1,
		draining: false,
	}
	lanes.set(lane, created)
	return created
}

function drainLane(lane: string) {
	const state = getLaneState(lane)
	if (state.draining) return
	state.draining = true

	const pump = () => {
		while (state.active < state.maxConcurrent && state.queue.length > 0) {
			const entry = state.queue.shift() as QueueEntry
			state.active += 1
			void (async () => {
				try {
					const result = await entry.task()
					state.active -= 1
					pump()
					entry.resolve(result)
				} catch (err) {
					state.active -= 1
					pump()
					entry.reject(err)
				}
			})()
		}
		state.draining = false
	}

	pump()
}

export function setLaneConcurrency(lane: string, maxConcurrent: number): void {
	const cleaned = lane.trim() || CommandLane.Main
	const state = getLaneState(cleaned)
	state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent))
	drainLane(cleaned)
}

export function enqueueCommandInLane<T>(
	lane: string,
	task: () => Promise<T>
): Promise<T> {
	const cleaned = lane.trim() || CommandLane.Main
	const state = getLaneState(cleaned)
	return new Promise<T>((resolve, reject) => {
		state.queue.push({
			task: () => task(),
			resolve: (value) => resolve(value as T),
			reject,
			enqueuedAt: Date.now(),
		})
		drainLane(cleaned)
	})
}

export function enqueueCommand<T>(task: () => Promise<T>): Promise<T> {
	return enqueueCommandInLane(CommandLane.Main, task)
}

export function getLaneQueueSize(lane: string = CommandLane.Main): number {
	const resolved = lane.trim() || CommandLane.Main
	const state = lanes.get(resolved)
	if (!state) return 0
	return state.queue.length + state.active
}

export function clearLane(lane: string = CommandLane.Main): number {
	const cleaned = lane.trim() || CommandLane.Main
	const state = lanes.get(cleaned)
	if (!state) return 0
	const removed = state.queue.length
	state.queue.length = 0
	return removed
}

// Default concurrency settings
export const DEFAULT_MAIN_CONCURRENCY = 1
export const DEFAULT_SUBAGENT_CONCURRENCY = 4
export const DEFAULT_CRON_CONCURRENCY = 1

export function initDefaultLanes(): void {
	setLaneConcurrency(CommandLane.Main, DEFAULT_MAIN_CONCURRENCY)
	setLaneConcurrency(CommandLane.Subagent, DEFAULT_SUBAGENT_CONCURRENCY)
	setLaneConcurrency(CommandLane.Cron, DEFAULT_CRON_CONCURRENCY)
}
