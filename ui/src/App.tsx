import { useEffect, useMemo, useState } from 'react'
import {
	bootstrap,
	createSession,
	detectChatId,
	fetchSteps,
	nextSessionStep,
	prevSessionStep,
	testConnection,
	updateSession,
} from './lib/api.tsx'

type WizardStep = {
	id: string
	title: string
	description?: string
}

type AgentType = 'claude' | 'droid' | 'custom'

type WizardData = {
	botToken: string
	chatId: string
	agentType: AgentType
	customAdapterName: string
	customAdaptersDir: string
	workspacePath: string
	userName: string
	timezone: string
	quietHours: string
	heartbeatEnabled: boolean
	heartbeatCron: string
	installDaemon: boolean
}

type TestResult = {
	ok: boolean
	bot?: { id: number; username?: string; firstName?: string }
	error?: string
}

type BootstrapResult = {
	ok: boolean
	workspace?: { workspacePath: string }
	config?: { configPath: string }
	cron?: { cronPath: string; jobId?: string }
	error?: string
}

const fallbackSteps: WizardStep[] = [
	{ id: 'welcome', title: 'Welcome' },
	{ id: 'telegram-bot', title: 'Telegram Bot' },
	{ id: 'chat-id', title: 'Chat ID' },
	{ id: 'agent', title: 'Agent' },
	{ id: 'workspace', title: 'Workspace' },
	{ id: 'about-you', title: 'About You' },
	{ id: 'heartbeat', title: 'Heartbeat' },
	{ id: 'background-service', title: 'Background Service' },
	{ id: 'test', title: 'Test' },
	{ id: 'done', title: 'Done' },
]

const defaultTimezone =
	Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const initialData: WizardData = {
	botToken: '',
	chatId: '',
	agentType: 'claude',
	customAdapterName: '',
	customAdaptersDir: '',
	workspacePath: '~/bites',
	userName: '',
	timezone: defaultTimezone,
	quietHours: '',
	heartbeatEnabled: true,
	heartbeatCron: '0 9 * * *',
	installDaemon: false,
}

const App = () => {
	const [steps, setSteps] = useState<WizardStep[]>(fallbackSteps)
	const [stepIndex, setStepIndex] = useState(0)
	const [sessionId, setSessionId] = useState<string | null>(null)
	const [data, setData] = useState<WizardData>(initialData)
	const [testResult, setTestResult] = useState<TestResult | null>(null)
	const [bootstrapResult, setBootstrapResult] = useState<BootstrapResult | null>(null)
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		fetchSteps()
			.then((res) => {
				if (res.ok && Array.isArray(res.steps)) {
					setSteps(res.steps as WizardStep[])
				}
			})
			.catch(() => {})

		createSession(initialData)
			.then((res: { ok: boolean; session?: any }) => {
				if (!res.ok || !res.session) return
				setSessionId(res.session.id)
				if (typeof res.session.stepIndex === 'number') {
					setStepIndex(res.session.stepIndex)
				}
				if (res.session.data) {
					setData((prev) => ({ ...prev, ...res.session.data }))
				}
			})
			.catch(() => {})
	}, [])

	const step = steps[stepIndex] ?? steps[0]
	const progressLabel = useMemo(
		() => `Step ${stepIndex + 1} of ${steps.length}`,
		[stepIndex, steps.length],
	)

	const setField = <K extends keyof WizardData>(key: K, value: WizardData[K]) => {
		setData((prev) => ({ ...prev, [key]: value }))
	}

	const isStepValid = () => {
		switch (step.id) {
			case 'telegram-bot':
				return data.botToken.trim().length > 0
			case 'chat-id':
				return data.chatId.trim().length > 0
			case 'agent':
				if (data.agentType === 'custom') {
					return (
						data.customAdapterName.trim().length > 0 &&
						data.customAdaptersDir.trim().length > 0
					)
				}
				return true
			case 'workspace':
				return data.workspacePath.trim().length > 0
			case 'about-you':
				return data.userName.trim().length > 0 && data.timezone.trim().length > 0
			case 'heartbeat':
				return data.heartbeatEnabled ? data.heartbeatCron.trim().length > 0 : true
			default:
				return true
		}
	}

	const syncSession = async () => {
		if (!sessionId) return
		await updateSession(sessionId, data).catch(() => {})
	}

	const handleNext = async () => {
		await syncSession()
		if (sessionId) {
			void nextSessionStep(sessionId).catch(() => {})
		}
		setStepIndex((prev) => Math.min(prev + 1, steps.length - 1))
	}

	const handleBack = async () => {
		await syncSession()
		if (sessionId) {
			void prevSessionStep(sessionId).catch(() => {})
		}
		setStepIndex((prev) => Math.max(prev - 1, 0))
	}

	const handleAutoDetect = async () => {
		setBusy(true)
		try {
			const res = await detectChatId()
			if (res.ok && res.chatId) {
				setField('chatId', String(res.chatId))
			}
		} finally {
			setBusy(false)
		}
	}

	const handleTest = async () => {
		setBusy(true)
		setTestResult(null)
		try {
			const result = await testConnection(data.botToken, data.chatId || undefined)
			setTestResult(result)
		} finally {
			setBusy(false)
		}
	}

	const handleBootstrap = async () => {
		setBusy(true)
		setBootstrapResult(null)
		try {
			const result = await bootstrap({ ...data })
			setBootstrapResult(result)
		} finally {
			setBusy(false)
		}
	}

	const renderStep = () => {
		switch (step.id) {
			case 'welcome':
				return (
					<div className="card">
						<p className="status">{progressLabel}</p>
						<h2>Let’s set up BitesBot</h2>
						<p>
							We’ll configure your Telegram bot, workspace, and heartbeat schedule.
						</p>
					</div>
				)
			case 'telegram-bot':
				return (
					<div className="form">
						<div>
							<label>Bot token</label>
							<input
								type="password"
								value={data.botToken}
								onChange={(event) => setField('botToken', event.target.value)}
								placeholder="123456:ABC-DEF1234..."
							/>
						</div>
						<p className="status">Grab this from BotFather in Telegram.</p>
					</div>
				)
			case 'chat-id':
				return (
					<div className="form">
						<div>
							<label>Chat ID</label>
							<input
								type="text"
								value={data.chatId}
								onChange={(event) => setField('chatId', event.target.value)}
								placeholder="123456789"
							/>
						</div>
						<div className="actions">
							<button className="button" onClick={handleAutoDetect} disabled={busy}>
								Auto-detect
							</button>
						</div>
					</div>
				)
			case 'agent':
				return (
					<div className="form">
						<div>
							<label>Agent</label>
							<select
								value={data.agentType}
								onChange={(event) =>
									setField('agentType', event.target.value as AgentType)
								}
							>
								<option value="claude">Claude</option>
								<option value="droid">Droid</option>
								<option value="custom">Custom CLI</option>
							</select>
						</div>
						{data.agentType === 'custom' ? (
							<>
								<div>
									<label>Custom adapter name</label>
									<input
										type="text"
										value={data.customAdapterName}
										onChange={(event) =>
											setField('customAdapterName', event.target.value)
										}
										placeholder="my-agent"
									/>
								</div>
								<div>
									<label>Adapters directory</label>
									<input
										type="text"
										value={data.customAdaptersDir}
										onChange={(event) =>
											setField('customAdaptersDir', event.target.value)
										}
										placeholder="/path/to/adapters"
									/>
								</div>
							</>
						) : null}
					</div>
				)
			case 'workspace':
				return (
					<div className="form">
						<div>
							<label>Workspace path</label>
							<input
								type="text"
								value={data.workspacePath}
								onChange={(event) => setField('workspacePath', event.target.value)}
								placeholder="~/bites"
							/>
						</div>
					</div>
				)
			case 'about-you':
				return (
					<div className="form">
						<div>
							<label>Name</label>
							<input
								type="text"
								value={data.userName}
								onChange={(event) => setField('userName', event.target.value)}
								placeholder="Your name"
							/>
						</div>
						<div>
							<label>Timezone</label>
							<input
								type="text"
								value={data.timezone}
								onChange={(event) => setField('timezone', event.target.value)}
								placeholder="America/Los_Angeles"
							/>
						</div>
						<div>
							<label>Quiet hours</label>
							<input
								type="text"
								value={data.quietHours}
								onChange={(event) => setField('quietHours', event.target.value)}
								placeholder="22:00-07:00"
							/>
						</div>
					</div>
				)
			case 'heartbeat':
				return (
					<div className="form">
						<div className="toggle">
							<input
								type="checkbox"
								checked={data.heartbeatEnabled}
								onChange={(event) => setField('heartbeatEnabled', event.target.checked)}
							/>
							<label>Enable heartbeat</label>
						</div>
						{data.heartbeatEnabled ? (
							<div>
								<label>Cron schedule</label>
								<input
									type="text"
									value={data.heartbeatCron}
									onChange={(event) => setField('heartbeatCron', event.target.value)}
									placeholder="0 9 * * *"
								/>
							</div>
						) : null}
					</div>
				)
			case 'background-service':
				return (
					<div className="form">
						<div className="toggle">
							<input
								type="checkbox"
								checked={data.installDaemon}
								onChange={(event) => setField('installDaemon', event.target.checked)}
							/>
							<label>Install as daemon</label>
						</div>
						<p className="status">
							You can start the gateway later using the CLI daemon flag.
						</p>
					</div>
				)
			case 'test':
				return (
					<div className="form">
						<button className="button" onClick={handleTest} disabled={busy}>
							Run connection test
						</button>
						{testResult ? (
							<div className="card">
								<p className="status">
									{testResult.ok
										? `Connected as ${testResult.bot?.username ?? testResult.bot?.firstName ?? 'bot'}`
										: testResult.error ?? 'Connection failed'}
								</p>
							</div>
						) : null}
					</div>
				)
			case 'done':
				return (
					<div className="form">
						<button className="button primary" onClick={handleBootstrap} disabled={busy}>
							Create workspace + config
						</button>
						{bootstrapResult ? (
							<div className="card">
								<p className="status">
									{bootstrapResult.ok
										? `Workspace created at ${bootstrapResult.workspace?.workspacePath ?? ''}`
										: bootstrapResult.error ?? 'Bootstrap failed'}
								</p>
								{bootstrapResult.ok && bootstrapResult.config?.configPath ? (
									<p className="status">Config: {bootstrapResult.config.configPath}</p>
								) : null}
							</div>
						) : null}
						{testResult?.bot?.username ? (
							<button
								className="button"
								onClick={() =>
									window.open(`https://t.me/${testResult.bot?.username}`, '_blank')
								}
							>
								Open Telegram
							</button>
						) : null}
					</div>
				)
			default:
				return null
		}
	}

	return (
		<div className="app">
			<aside className="sidebar">
				<h1>BitesBot Setup</h1>
				<div className="steps">
					{steps.map((item, index) => (
						<div
							key={item.id}
							className={`step ${index === stepIndex ? 'active' : ''}`}
							onClick={() => setStepIndex(index)}
						>
							<div>{item.title}</div>
						</div>
					))}
				</div>
			</aside>
			<main className="content">
				<h2>{step.title}</h2>
				{step.description ? <p>{step.description}</p> : null}
				{renderStep()}
				<div className="actions">
					<button className="button" onClick={handleBack} disabled={stepIndex === 0}>
						Back
					</button>
					{step.id !== 'done' ? (
						<button
							className="button primary"
							onClick={handleNext}
							disabled={!isStepValid()}
						>
							Next
						</button>
					) : null}
				</div>
			</main>
		</div>
	)
}

export default App
