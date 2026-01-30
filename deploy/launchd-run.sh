#!/bin/sh
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

find_node() {
	if [ -x "$HOME/.volta/bin/node" ]; then
		echo "$HOME/.volta/bin/node"
		return 0
	fi
	if [ -x "$HOME/.asdf/shims/node" ]; then
		echo "$HOME/.asdf/shims/node"
		return 0
	fi
	if [ -x "/opt/homebrew/bin/node" ]; then
		echo "/opt/homebrew/bin/node"
		return 0
	fi
	if [ -x "/usr/local/bin/node" ]; then
		echo "/usr/local/bin/node"
		return 0
	fi
	if [ -x "/usr/bin/node" ]; then
		echo "/usr/bin/node"
		return 0
	fi
	if [ -d "$HOME/.nvm/versions/node" ]; then
		NVM_NODE="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -n 1)"
		if [ -n "$NVM_NODE" ] && [ -x "$HOME/.nvm/versions/node/$NVM_NODE/bin/node" ]; then
			echo "$HOME/.nvm/versions/node/$NVM_NODE/bin/node"
			return 0
		fi
	fi
	if command -v node >/dev/null 2>&1; then
		command -v node
		return 0
	fi
	return 1
}

NODE_PATH="$(find_node || true)"
if [ -z "$NODE_PATH" ]; then
	echo "node not found" >&2
	exit 127
fi

if [ "$#" -eq 0 ]; then
	set -- start
fi

exec "$NODE_PATH" "$ROOT_DIR/dist/daemon/cli.js" "$@"
