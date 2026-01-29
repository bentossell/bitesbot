import { TelegramClient, sessions } from 'telegram'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const apiId = Number(process.env.TG_E2E_API_ID ?? '')
const apiHash = process.env.TG_E2E_API_HASH ?? ''

if (!apiId || !apiHash) {
	console.error('Missing TG_E2E_API_ID or TG_E2E_API_HASH')
	process.exit(1)
}

const rl = createInterface({ input, output })
const { StringSession } = sessions
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 })

const main = async () => {
	try {
		await client.start({
			phoneNumber: async () => rl.question('Phone number (E.164): '),
			phoneCode: async () => rl.question('Login code: '),
			password: async () => rl.question('2FA password (press enter if none): '),
			onError: (err) => console.error(err),
		})

		const session = client.session.save()
		console.log(session)
	} finally {
		rl.close()
		await client.disconnect()
	}
}

void main()
