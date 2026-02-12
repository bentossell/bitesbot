export type WizardStepId =
	| 'welcome'
	| 'telegram-bot'
	| 'chat-id'
	| 'agent'
	| 'workspace'
	| 'about-you'
	| 'heartbeat'
	| 'background-service'
	| 'test'
	| 'done'

export type WizardFieldType = 'text' | 'password' | 'select' | 'toggle' | 'path' | 'cron'

export type WizardFieldOption = {
	label: string
	value: string
}

export type WizardField = {
	key: string
	label: string
	type: WizardFieldType
	required?: boolean
	placeholder?: string
	options?: WizardFieldOption[]
}

export type WizardStep = {
	id: WizardStepId
	title: string
	description?: string
	fields?: WizardField[]
}

export const wizardSteps: WizardStep[] = [
	{
		id: 'welcome',
		title: "Let's set up BitesBot",
		description: 'We will configure Telegram, agent, workspace, and heartbeat.',
	},
	{
		id: 'telegram-bot',
		title: 'Telegram Bot',
		description: 'Paste your BotFather token.',
		fields: [
			{
				key: 'botToken',
				label: 'Bot token',
				type: 'password',
				required: true,
				placeholder: '123456:ABC-DEF1234...',
			},
		],
	},
	{
		id: 'chat-id',
		title: 'Your Chat ID',
		description: 'Auto-detect from recent chat or paste manually.',
		fields: [
			{
				key: 'chatId',
				label: 'Chat ID',
				type: 'text',
				required: true,
				placeholder: '123456789',
			},
		],
	},
	{
		id: 'agent',
		title: 'Agent',
		description: 'Pick the CLI agent to run.',
		fields: [
			{
				key: 'agentType',
				label: 'Agent',
				type: 'select',
				required: true,
				options: [
					{ label: 'Claude', value: 'claude' },
					{ label: 'Droid', value: 'droid' },
					{ label: 'Custom CLI', value: 'custom' },
				],
			},
			{
				key: 'customAdapterName',
				label: 'Custom adapter name',
				type: 'text',
				placeholder: 'my-agent',
			},
			{
				key: 'customAdaptersDir',
				label: 'Adapters directory',
				type: 'path',
				placeholder: '/path/to/adapters',
			},
		],
	},
	{
		id: 'workspace',
		title: 'Workspace',
		description: 'Choose a workspace folder.',
		fields: [
			{
				key: 'workspacePath',
				label: 'Workspace path',
				type: 'path',
				required: true,
				placeholder: '~/bites',
			},
		],
	},
	{
		id: 'about-you',
		title: 'About You',
		description: 'Used to write USER.md.',
		fields: [
			{ key: 'userName', label: 'Name', type: 'text', required: true, placeholder: 'Your name' },
			{ key: 'timezone', label: 'Timezone', type: 'text', required: true, placeholder: 'America/Los_Angeles' },
			{ key: 'quietHours', label: 'Quiet hours', type: 'text', placeholder: '22:00-07:00' },
		],
	},
	{
		id: 'heartbeat',
		title: 'Heartbeat',
		description: 'Enable proactive checks and schedule.',
		fields: [
			{ key: 'heartbeatEnabled', label: 'Enable heartbeat', type: 'toggle' },
			{ key: 'heartbeatCron', label: 'Cron schedule', type: 'cron', placeholder: '0 9 * * *' },
		],
	},
	{
		id: 'background-service',
		title: 'Background Service',
		description: 'Install gateway as a daemon.',
		fields: [{ key: 'installDaemon', label: 'Install as daemon', type: 'toggle' }],
	},
	{
		id: 'test',
		title: 'Test',
		description: 'Verify connection with Telegram.',
	},
	{
		id: 'done',
		title: 'Done',
		description: 'Open Telegram and start chatting.',
	},
]

export const wizardStepOrder = wizardSteps.map((step) => step.id)
