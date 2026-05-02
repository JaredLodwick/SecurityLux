#!/usr/bin/env bash
# Install MMM-DoorCam into a local MagicMirror checkout.
#
# Strategy: the module's files live in this repo (so they're version-controlled
# alongside the camera client). We expose them to MagicMirror via a symlink
# from `<MagicMirror>/modules/MMM-DoorCam` into this directory, and we add a
# `node_modules` symlink inside the module so Node's require() can find
# MagicMirror's bundled `ws` and `node_helper` packages when MM loads us.
#
# We also install the hub-side detection deps (onnxruntime-node, sharp,
# better-sqlite3) into MagicMirror's own node_modules so the helper picks them
# up via the same symlink.
#
# Usage:
#   ./mm_module/install.sh                      # auto-detect ~/MagicMirror
#   ./mm_module/install.sh /path/to/MagicMirror

set -euo pipefail

MM_ROOT="${1:-$HOME/MagicMirror}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/MMM-DoorCam"
TARGET_LINK="$MM_ROOT/modules/MMM-DoorCam"
NODE_MODULES_LINK="$SOURCE_DIR/node_modules"
MM_NODE_MODULES="$MM_ROOT/node_modules"
DETECTION_DEPS=(onnxruntime-node sharp better-sqlite3)

if [[ ! -d "$MM_ROOT" ]]; then
    echo "MagicMirror not found at: $MM_ROOT" >&2
    echo "Pass the path as the first argument." >&2
    exit 1
fi
if [[ ! -d "$MM_NODE_MODULES" ]]; then
    echo "Expected node_modules at: $MM_NODE_MODULES" >&2
    echo "Run 'npm install' inside MagicMirror first." >&2
    exit 1
fi

# Module symlink: <MagicMirror>/modules/MMM-DoorCam -> <repo>/mm_module/MMM-DoorCam
mkdir -p "$MM_ROOT/modules"
if [[ -L "$TARGET_LINK" ]]; then
    rm "$TARGET_LINK"
elif [[ -e "$TARGET_LINK" ]]; then
    echo "Refusing to overwrite existing non-symlink: $TARGET_LINK" >&2
    exit 1
fi
ln -s "$SOURCE_DIR" "$TARGET_LINK"
echo "linked: $TARGET_LINK -> $SOURCE_DIR"

# node_modules symlink inside the module (gitignored).
# Lets `require('ws')` and `require('node_helper')` resolve to MM's bundle.
if [[ -L "$NODE_MODULES_LINK" ]]; then
    rm "$NODE_MODULES_LINK"
elif [[ -e "$NODE_MODULES_LINK" ]]; then
    echo "Refusing to overwrite existing non-symlink: $NODE_MODULES_LINK" >&2
    exit 1
fi
ln -s "$MM_NODE_MODULES" "$NODE_MODULES_LINK"
echo "linked: $NODE_MODULES_LINK -> $MM_NODE_MODULES"

# Hub-side detection deps. Install into MM's node_modules so our symlink picks
# them up. Skip the install if all packages are already present (idempotent).
missing=()
for pkg in "${DETECTION_DEPS[@]}"; do
    if [[ ! -d "$MM_NODE_MODULES/$pkg" ]]; then
        missing+=("$pkg")
    fi
done
if (( ${#missing[@]} > 0 )); then
    echo "installing detection deps into MagicMirror: ${missing[*]}"
    ( cd "$MM_ROOT" && npm install --no-audit --no-fund "${missing[@]}" )
else
    echo "detection deps already present: ${DETECTION_DEPS[*]}"
fi

# ffmpeg is used to record per-event clips. Warn (don't fail) if it's missing —
# detection still runs, sessions just get logged without a clip_path.
if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "WARNING: ffmpeg not found on PATH." >&2
    echo "  Install with: sudo apt-get install -y ffmpeg" >&2
    echo "  Without ffmpeg, person events are still detected and logged but no" >&2
    echo "  video clip will be recorded." >&2
fi

echo "done. Restart MagicMirror to load the module."
