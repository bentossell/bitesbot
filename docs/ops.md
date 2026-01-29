# Operations

## Deployment notes

- Default port: 8787
- Health check: `curl http://localhost:8787/health`
- Status endpoint: `curl http://localhost:8787/status`
- Launchd service: `com.bentossell.bitesbot`
- Logs: `~/logs/bitesbot.log` and `~/logs/bitesbot.err`

## Launchd commands

```bash
npm run gateway:daemon
npm run gateway:stop
npm run gateway:status
```

## Port conflicts (EADDRINUSE)

1) Check the port:

```bash
lsof -i :8787
```

2) If launchd is respawning (KeepAlive=true):

```bash
launchctl unload ~/Library/LaunchAgents/com.bentossell.bitesbot.plist
sleep 3
launchctl load ~/Library/LaunchAgents/com.bentossell.bitesbot.plist
```

3) If zombie processes:

```bash
lsof -ti :8787 | xargs kill -9
```

4) Verify:

```bash
curl http://localhost:8787/health
```
