#!/bin/sh
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="${TG_GATEWAY_TEST_LAUNCHD_LABEL:-com.bentossell.bitesbot.test}"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

load_env() {
	if [ -f "$ROOT_DIR/.env.e2e" ]; then
		set -a
		. "$ROOT_DIR/.env.e2e"
		set +a
	fi
}

resolve_pi_bin() {
	if [ -n "${TG_GATEWAY_CLI_PI_BIN:-}" ]; then
		echo "$TG_GATEWAY_CLI_PI_BIN"
		return 0
	fi
	if command -v pi >/dev/null 2>&1; then
		command -v pi
		return 0
	fi
	if [ -d "$HOME/.nvm/versions/node" ]; then
		NVM_NODE="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -n 1)"
		if [ -n "$NVM_NODE" ] && [ -x "$HOME/.nvm/versions/node/$NVM_NODE/bin/pi" ]; then
			echo "$HOME/.nvm/versions/node/$NVM_NODE/bin/pi"
			return 0
		fi
	fi
	echo ""
}

install_plist() {
	load_env
	if [ -z "${TG_E2E_BOT_TOKEN:-}" ]; then
		echo "Missing TG_E2E_BOT_TOKEN in .env.e2e" >&2
		exit 1
	fi
	if [ -z "${TG_E2E_ALLOWED_CHAT_ID:-}" ]; then
		echo "Missing TG_E2E_ALLOWED_CHAT_ID in .env.e2e" >&2
		exit 1
	fi

	PORT="${TG_E2E_GATEWAY_PORT:-8788}"
	TEST_CONFIG_DIR="${TG_GATEWAY_TEST_CONFIG_DIR:-$HOME/.config/tg-gateway-test}"
	LOG_DIR="${TG_GATEWAY_TEST_LOG_DIR:-$TEST_CONFIG_DIR/logs}"
	PID_PATH="${TG_GATEWAY_TEST_PID_PATH:-$TEST_CONFIG_DIR/tg-gateway.pid}"
	STDOUT_LOG="${TG_GATEWAY_TEST_STDOUT_LOG:-$HOME/logs/bitesbot-test.log}"
	STDERR_LOG="${TG_GATEWAY_TEST_STDERR_LOG:-$HOME/logs/bitesbot-test.err}"
	DEFAULT_CLI="${TG_GATEWAY_TEST_DEFAULT_CLI:-pi}"
	WORKDIR="${TG_GATEWAY_TEST_WORKDIR:-$ROOT_DIR}"
	ADAPTERS_DIR="${TG_GATEWAY_TEST_ADAPTERS_DIR:-$ROOT_DIR/adapters}"
	MEMORY_ENABLED="${TG_GATEWAY_TEST_MEMORY_ENABLED:-false}"
	PI_BIN="$(resolve_pi_bin)"
	PATH_ENV="${PATH}"

	mkdir -p "$HOME/Library/LaunchAgents"
	mkdir -p "$LOG_DIR"
	mkdir -p "$(dirname "$STDOUT_LOG")"

	cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${ROOT_DIR}/deploy/launchd-run.sh</string>
        <string>start</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${ROOT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${STDOUT_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${STDERR_LOG}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${PATH_ENV}</string>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>TG_GATEWAY_CONFIG</key>
        <string>/dev/null</string>
        <key>TG_GATEWAY_BOT_TOKEN</key>
        <string>${TG_E2E_BOT_TOKEN}</string>
        <key>TG_GATEWAY_PORT</key>
        <string>${PORT}</string>
        <key>TG_GATEWAY_ALLOWED_CHAT_IDS</key>
        <string>${TG_E2E_ALLOWED_CHAT_ID}</string>
        <key>TG_GATEWAY_AUTH_TOKEN</key>
        <string>${TG_E2E_AUTH_TOKEN:-}</string>
        <key>TG_GATEWAY_BRIDGE_ENABLED</key>
        <string>true</string>
        <key>TG_GATEWAY_DEFAULT_CLI</key>
        <string>${DEFAULT_CLI}</string>
        <key>TG_GATEWAY_WORKING_DIR</key>
        <string>${WORKDIR}</string>
        <key>TG_GATEWAY_ADAPTERS_DIR</key>
        <string>${ADAPTERS_DIR}</string>
        <key>TG_GATEWAY_MEMORY_ENABLED</key>
        <string>${MEMORY_ENABLED}</string>
        <key>TG_GATEWAY_LOG_DIR</key>
        <string>${LOG_DIR}</string>
        <key>TG_GATEWAY_PID_PATH</key>
        <string>${PID_PATH}</string>
        <key>TG_GATEWAY_LAUNCHD_LABEL</key>
        <string>${LABEL}</string>
        <key>TG_GATEWAY_LAUNCHD_PLIST</key>
        <string>${PLIST_PATH}</string>
        <key>TG_GATEWAY_CLI_PI_BIN</key>
        <string>${PI_BIN}</string>
    </dict>
</dict>
</plist>
PLIST
}

uninstall_plist() {
	if [ -f "$PLIST_PATH" ]; then
		launchctl unload "$PLIST_PATH" 2>/dev/null || true
		rm -f "$PLIST_PATH"
	fi
}

restart_plist() {
	if [ -f "$PLIST_PATH" ]; then
		launchctl unload "$PLIST_PATH" 2>/dev/null || true
		launchctl load "$PLIST_PATH"
	else
		echo "Missing plist: $PLIST_PATH" >&2
		exit 1
	fi
}

status_plist() {
	launchctl list "$LABEL" 2>/dev/null && exit 0
	echo "launchd not running (${LABEL})"
	exit 1
}

case "${1:-install}" in
	install)
		install_plist
		launchctl load "$PLIST_PATH"
		;;
	uninstall)
		uninstall_plist
		;;
	restart)
		restart_plist
		;;
	status)
		status_plist
		;;
	*)
		echo "Usage: $0 {install|uninstall|restart|status}" >&2
		exit 1
		;;
	esac
