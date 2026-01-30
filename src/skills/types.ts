export type SkillMetadata = {
	name: string
	description?: string
	requires?: Array<{ bin: string } | { env: string }>
	platforms?: Array<'darwin' | 'linux' | 'win32'>
}

export type Skill = {
	name: string
	description?: string
	path: string
	source: 'personal' | 'factory' | 'claude' | 'workspace'
	available: boolean
	unavailableReason?: string
}

export type SkillDirectories = {
	personal?: string
	factory?: string
	claude?: string
	workspace?: string
}
