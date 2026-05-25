#!/usr/bin/env bash
# Install MMM-SecurityLuxDisplay into a local MagicMirror checkout.
#
# This is a thin display module — it just renders frames + status fetched
# from a SecurityLuxHub running somewhere on the LAN. There's nothing to
# `npm install` here; the module has no node-side dependencies.
#
# Strategy: symlink <MagicMirror>/modules/MMM-SecurityLuxDisplay into this
# repo so MagicMirror finds and loads it.
#
# Usage:
#   ./mm_module/install.sh                      # auto-detect ~/MagicMirror
#   ./mm_module/install.sh /path/to/MagicMirror
#   ./mm_module/install.sh /path/to/MagicMirror http://hub:5000 front bottom_left

set -euo pipefail

MM_ROOT="${1:-$HOME/MagicMirror}"
HUB_URL="${2:-}"
CAM_ID="${3:-}"
POSITION="${4:-}"
TITLE="${5:-Security Lux}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/MMM-SecurityLuxDisplay"
TARGET_LINK="$MM_ROOT/modules/MMM-SecurityLuxDisplay"
CONFIG_DIR="$MM_ROOT/config"
CONFIG_FILE="$CONFIG_DIR/config.js"
CONFIG_SAMPLE="$CONFIG_DIR/config.js.sample"
CONFIGURE_SCRIPT="$SCRIPT_DIR/configure_magicmirror.js"

POSITIONS=(
    bottom_left
    bottom_right
    top_left
    top_center
    top_right
    bottom_center
    top_bar
    upper_third
    middle_center
    lower_third
    bottom_bar
    fullscreen_above
    fullscreen_below
)

prompt_default () {
    local prompt="$1" default="$2" input
    printf "%s [%s]: " "$prompt" "$default" >&2
    read -r input
    echo "${input:-$default}"
}

choose_position () {
    local choice
    if [[ -n "$POSITION" ]]; then
        echo "$POSITION"
        return
    fi

    echo >&2
    echo "Choose the MagicMirror position for MMM-SecurityLuxDisplay:" >&2
    for i in "${!POSITIONS[@]}"; do
        printf "  %2d) %s\n" "$((i + 1))" "${POSITIONS[$i]}" >&2
    done
    echo >&2
    printf "Enter 1-%s [1]: " "${#POSITIONS[@]}" >&2
    read -r choice
    choice="${choice:-1}"
    if [[ ! "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#POSITIONS[@]} )); then
        echo "ERROR: invalid position choice '$choice'." >&2
        exit 1
    fi
    echo "${POSITIONS[$((choice - 1))]}"
}

if [[ ! -d "$MM_ROOT" ]]; then
    echo "MagicMirror not found at: $MM_ROOT" >&2
    echo "Pass the path as the first argument." >&2
    exit 1
fi
if [[ ! -d "$SOURCE_DIR" ]]; then
    echo "Module source not found at: $SOURCE_DIR" >&2
    exit 1
fi
if [[ ! -f "$CONFIGURE_SCRIPT" ]]; then
    echo "Config helper not found at: $CONFIGURE_SCRIPT" >&2
    exit 1
fi
if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node is required to update MagicMirror's config.js." >&2
    exit 1
fi

HUB_URL="${HUB_URL:-$(prompt_default "Hub URL the module should poll" "http://meer.local:5000")}"
CAM_ID="${CAM_ID:-$(prompt_default "Camera ID to display" "front")}"
POSITION="$(choose_position)"

mkdir -p "$MM_ROOT/modules"

# Best-effort cleanup of stale symlinks from earlier module names.
for old_name in MMM-LuxSecurityDisplay MMM-DoorCam; do
    old_link="$MM_ROOT/modules/$old_name"
    if [[ -L "$old_link" ]]; then
        echo "removing stale symlink: $old_link"
        rm "$old_link"
    elif [[ -e "$old_link" ]]; then
        echo "WARNING: $old_link exists and is not a symlink — leaving it alone." >&2
        echo "         You can delete it manually if you no longer need it." >&2
    fi
done

# New module symlink.
if [[ -L "$TARGET_LINK" ]]; then
    rm "$TARGET_LINK"
elif [[ -e "$TARGET_LINK" ]]; then
    echo "Refusing to overwrite existing non-symlink: $TARGET_LINK" >&2
    exit 1
fi
ln -s "$SOURCE_DIR" "$TARGET_LINK"
echo "linked: $TARGET_LINK -> $SOURCE_DIR"

if [[ ! -f "$CONFIG_FILE" ]]; then
    if [[ -f "$CONFIG_SAMPLE" ]]; then
        echo "==> Creating $CONFIG_FILE from config.js.sample..."
        cp "$CONFIG_SAMPLE" "$CONFIG_FILE"
    else
        echo "ERROR: MagicMirror config not found at $CONFIG_FILE and no config.js.sample exists." >&2
        exit 1
    fi
fi

echo "==> Updating MagicMirror config..."
node "$CONFIGURE_SCRIPT" "$CONFIG_FILE" "$HUB_URL" "$CAM_ID" "$POSITION" "$TITLE"

cat <<EOF

==============================================================
 MMM-SecurityLuxDisplay installed.

 Config updated:
   $CONFIG_FILE

 Module settings:
   hubUrl:   $HUB_URL
   camId:    $CAM_ID
   position: $POSITION

 Next:
   Restart MagicMirror.
==============================================================
EOF
