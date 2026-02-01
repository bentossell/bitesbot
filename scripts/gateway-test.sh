#!/bin/sh
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

load_env() {
	if [ -f "$ROOT_DIR/.env.e2e" ]; then
		set -a
		. "$ROOT_DIR/.env.e2e"
		set +a
	fi
}

require_env() {
	if [ -z "${TG_E2E_BOT_TOKEN:-}" ]; then
		echo "Missing TG_E2E_BOT_TOKEN in .env.e2e" >&2
		exit 1
	fi
	if [ -z "${TG_E2E_ALLOWED_CHAT_ID:-}" ]; then
		echo "Missing TG_E2E_ALLOWED_CHAT_ID in .env.e2e" >&2
		exit 1
	fi
}

resolve_defaults() {
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
}

export_env() {
	export TG_GATEWAY_CONFIG=/dev/null
	export TG_GATEWAY_BOT_TOKEN="$TG_E2E_BOT_TOKEN"
	export TG_GATEWAY_PORT="$PORT"
	export TG_GATEWAY_ALLOWED_CHAT_IDS="$TG_E2E_ALLOWED_CHAT_ID"
	export TG_GATEWAY_AUTH_TOKEN="${TG_E2E_AUTH_TOKEN:-}"
	export TG_GATEWAY_BRIDGE_ENABLED=true
	export TG_GATEWAY_DEFAULT_CLI="$DEFAULT_CLI"
	export TG_GATEWAY_WORKING_DIR="$WORKDIR"
	export TG_GATEWAY_ADAPTERS_DIR="$ADAPTERS_DIR"
	export TG_GATEWAY_MEMORY_ENABLED="$MEMORY_ENABLED"
	export TG_GATEWAY_LOG_DIR="$LOG_DIR"
	export TG_GATEWAY_PID_PATH="$PID_PATH"

	if [ -n "${TG_GATEWAY_CLI_PI_BIN:-}" ]; then
		export TG_GATEWAY_CLI_PI_BIN="$TG_GATEWAY_CLI_PI_BIN"
	elif [ -n "${TG_GATEWAY_TEST_PI_BIN:-}" ]; then
		export TG_GATEWAY_CLI_PI_BIN="$TG_GATEWAY_TEST_PI_BIN"
	fi
}

ensure_dirs() {
	mkdir -p "$LOG_DIR"
	mkdir -p "$(dirname "$STDOUT_LOG")"
}

build_if_needed() {
	if [ "${TG_GATEWAY_TEST_BUILD:-1}" = "0" ]; then
		return 0
	fi
	(cd "$ROOT_DIR" && pnpm run build)
}

stop_by_pid() {
	if [ -f "$PID_PATH" ]; then
		pid="$(cat "$PID_PATH" 2>/dev/null || true)"
		if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
			kill "$pid" 2>/dev/null || true
			for _ in 1 2 3 4 5; do
				if ! kill -0 "$pid" 2>/dev/null; then
					return 0
				fi
				sleep 1
			done
			kill -9 "$pid" 2>/dev/null || true
		fi
	fi
}

stop_by_port() {
	pid="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null || true)"
	if [ -n "$pid" ]; then
		cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
		case "$cmd" in
			*"$ROOT_DIR"*"dist/daemon/cli.js"* )
				kill "$pid" 2>/dev/null || true
				;;
			* )
				echo "Port $PORT is in use by another process: $cmd" >&2
				exit 1
				;;
		esac
	fi
}

status() {
	if [ -f "$PID_PATH" ]; then
		pid="$(cat "$PID_PATH" 2>/dev/null || true)"
		if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
			echo "running (pid $pid)"
			return 0
		fi
	fi
	echo "not running"
	return 1
}

start_background() {
	ensure_dirs
	build_if_needed
	stop_by_pid
	stop_by_port
	(cd "$ROOT_DIR" && nohup node dist/daemon/cli.js start >> "$STDOUT_LOG" 2>> "$STDERR_LOG" &)
	sleep 1
	curl -s "http://127.0.0.1:$PORT/health" >/dev/null || true
}

start_foreground() {
	ensure_dirs
	build_if_needed
	stop_by_pid
	stop_by_port
	cd "$ROOT_DIR"
	exec node dist/daemon/cli.js start
}

logs() {
	if [ -f "$STDOUT_LOG" ]; then
		tail -n 200 "$STDOUT_LOG"
	else
		echo "No log at $STDOUT_LOG"
	fi
}

main() {
	ACTION="${1:-start}"
	load_env
	require_env
	resolve_defaults
	export_env

	case "$ACTION" in
		start)
			start_background
			;;
		start-foreground)
			start_foreground
			;;
		restart)
			start_background
			;;
		stop)
			stop_by_pid
			;;
		status)
			status
			;;
		logs)
			logs
			;;
		*)
			echo "Usage: $0 {start|start-foreground|restart|stop|status|logs}" >&2
			exit 1
			;;
	esac
}

main "$@"
