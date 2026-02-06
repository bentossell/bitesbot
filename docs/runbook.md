---
summary: "Operations guide: deploy, start/stop, monitoring, incidents"
read_when:
  - Starting or stopping the gateway
  - Something is broken
  - Checking logs or health
  - Setting up launchd service
---

# Runbook — bitesbot

## Start/Stop Gateway

### Foreground (dev/debug)

```bash
pnpm gateway           # Runs in foreground, Ctrl+C to stop
pnpm dev               # Watch mode, auto-restarts on changes
```

### Background daemon

```bash
pnpm gateway:daemon    # Start as daemon
pnpm gateway:stop      # Stop daemon
pnpm gateway:status    # Check if running
pnpm gateway:restart   # Stop + start
```

### Launchd service (auto-start on boot)

```bash
# Setup (one time)
./deploy/setup-launchd.sh

# Control
pnpm gateway:launchd:start     # Load service
pnpm gateway:launchd:stop      # Unload service
pnpm gateway:launchd:status    # Check status
pnpm gateway:launchd:restart   # Restart service

# Or directly:
launchctl load ~/Library/LaunchAgents/com.bentossell.bitesbot.plist
launchctl unload ~/Library/LaunchAgents/com.bentossell.bitesbot.plist
```

## Health Checks

```bash
# Quick health
curl -s http://localhost:8787/health
# Returns: {"status":"ok"}

# Full status
curl -s http://localhost:8787/status | jq

# Check if process is running
pnpm gateway:status
# Or: lsof -i :8787
```

## Logs

```bash
# Stdout log
tail -100 ~/logs/bitesbot.log

# Stderr/errors
tail -100 ~/logs/bitesbot.err

# Follow logs live
tail -f ~/logs/bitesbot.log

# Search for errors
grep -i error ~/logs/bitesbot.err | tail -20
```

## Deploy (after changes)

```bash
# Build and restart
pnpm gateway:restart:build

# Or manually:
pnpm build
pnpm gateway:restart

# If using launchd:
pnpm build
pnpm gateway:launchd:restart
```

**Pre-deploy checklist:**
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test:unit` passes
- [ ] Changes committed

## Port Conflicts (EADDRINUSE)

1. Check what's using the port:
```bash
lsof -i :8787
```

2. If launchd is respawning:
```bash
launchctl unload ~/Library/LaunchAgents/com.bentossell.bitesbot.plist
sleep 3
lsof -ti :8787 | xargs kill -9
launchctl load ~/Library/LaunchAgents/com.bentossell.bitesbot.plist
```

3. If zombie process:
```bash
lsof -ti :8787 | xargs kill -9
```

4. Verify:
```bash
curl http://localhost:8787/health
```

## Test Gateway (separate instance)

For testing without affecting production:

```bash
pnpm gateway:test           # Start on port 8788
pnpm gateway:test:stop      # Stop test instance
pnpm gateway:test:status    # Check test gateway
pnpm gateway:test:logs      # View test logs
```

Test gateway uses `.env.e2e` configuration.

## Incidents

### Gateway is down

1. Check health: `curl http://localhost:8787/health`
2. Check if process exists: `lsof -i :8787`
3. Check logs: `tail -50 ~/logs/bitesbot.err`
4. Restart: `pnpm gateway:restart` or `pnpm gateway:launchd:restart`

### Telegram messages not being received

1. Check bot token is valid
2. Check `allowedChatIds` includes the chat
3. Check logs for Telegram errors
4. Verify webhook/polling is running: `curl http://localhost:8787/status`

### CLI agent not responding

1. Check bridge is enabled in config
2. Check adapter exists in `adapters/`
3. Check CLI binary is in PATH
4. Check logs for spawn errors

## Secrets Management

| Secret | Location | Purpose |
|--------|----------|---------|
| Bot token | `~/.config/tg-gateway/config.json` | Telegram bot |
| Auth token | Config file | HTTP/WS auth |
| API keys | `~/.secrets` (via bridge.envFile) | CLI adapters |

## Service Info

- **Service name:** `com.bentossell.bitesbot`
- **Default port:** 8787
- **Test port:** 8788
- **Logs:** `~/logs/bitesbot.log`, `~/logs/bitesbot.err`
- **Config:** `~/.config/tg-gateway/config.json`
- **PID file:** `/tmp/tg-gateway.pid`
