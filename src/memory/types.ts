export type MemoryLinksConfig = {
	enabled: boolean
	maxBacklinks: number
	maxForwardLinks: number
	configDir?: string
}

export type MemoryConfig = {
	enabled: boolean
	workspaceDir: string
	qmdPath: string
	qmdCollection: string
	qmdIndexPath?: string
	maxResults: number
	minScore?: number
	links: MemoryLinksConfig
}
