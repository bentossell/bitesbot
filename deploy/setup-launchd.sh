#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$SCRIPT_DIR/launchd.plist.template"

LAUNCHD_LABEL="${LAUNCHD_LABEL:-com.$(whoami).tg-gateway}"
PLIST_PATH="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
LOG_DIR="$HOME/logs"

usage() {
    cat <<EOF
Usage: $(basename "$0") [options]

Generate and install launchd plist for tg-gateway.

Options:
  -l, --label LABEL    Set launchd label (default: com.\$USER.tg-gateway)
  -o, --output PATH    Output plist path (default: ~/Library/LaunchAgents/\$LABEL.plist)
  -n, --dry-run        Print generated plist without installing
  -h, --help           Show this help

Environment:
  LAUNCHD_LABEL        Alternative to --label

Examples:
  $(basename "$0")                      # Install with defaults
  $(basename "$0") --dry-run            # Preview without installing
  $(basename "$0") -l com.me.mybot      # Custom label
EOF
}

DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -l|--label)
            LAUNCHD_LABEL="$2"
            shift 2
            ;;
        -o|--output)
            PLIST_PATH="$2"
            shift 2
            ;;
        -n|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

# Build PATH with common Node.js manager paths
BUILD_PATH=""
[[ -d "$HOME/.volta/bin" ]] && BUILD_PATH="$HOME/.volta/bin:"
[[ -d "$HOME/.asdf/shims" ]] && BUILD_PATH="$BUILD_PATH$HOME/.asdf/shims:"
[[ -d "$HOME/.nvm/current/bin" ]] && BUILD_PATH="$BUILD_PATH$HOME/.nvm/current/bin:"
[[ -d "$HOME/.fnm/current/bin" ]] && BUILD_PATH="$BUILD_PATH$HOME/.fnm/current/bin:"
BUILD_PATH="$BUILD_PATH/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

generate_plist() {
    sed \
        -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
        -e "s|{{HOME}}|$HOME|g" \
        -e "s|{{LAUNCHD_LABEL}}|$LAUNCHD_LABEL|g" \
        -e "s|{{PATH}}|$BUILD_PATH|g" \
        "$TEMPLATE"
}

if $DRY_RUN; then
    echo "# Generated plist (dry run):"
    echo "# Label: $LAUNCHD_LABEL"
    echo "# Output: $PLIST_PATH"
    echo ""
    generate_plist
    exit 0
fi

# Create log directory
mkdir -p "$LOG_DIR"

# Unload existing service if present
if launchctl list "$LAUNCHD_LABEL" &>/dev/null; then
    echo "Unloading existing service..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Generate and install plist
echo "Generating plist..."
generate_plist > "$PLIST_PATH"

echo "Loading service..."
launchctl load "$PLIST_PATH"

echo ""
echo "Installed: $PLIST_PATH"
echo "Label: $LAUNCHD_LABEL"
echo ""
echo "Commands:"
echo "  launchctl start $LAUNCHD_LABEL"
echo "  launchctl stop $LAUNCHD_LABEL"
echo "  launchctl unload $PLIST_PATH"
