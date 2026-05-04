#!/usr/bin/env bash
# Install MMM-LuxSecurityDisplay into a local MagicMirror checkout.
#
# This is a thin display module — it just renders frames + status fetched
# from a LuxSecurityHub running somewhere on the LAN. There's nothing to
# `npm install` here; the module has no node-side dependencies.
#
# Strategy: symlink <MagicMirror>/modules/MMM-LuxSecurityDisplay into this
# repo so MagicMirror finds and loads it.
#
# Usage:
#   ./mm_module/install.sh                      # auto-detect ~/MagicMirror
#   ./mm_module/install.sh /path/to/MagicMirror

set -euo pipefail

MM_ROOT="${1:-$HOME/MagicMirror}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/MMM-LuxSecurityDisplay"
TARGET_LINK="$MM_ROOT/modules/MMM-LuxSecurityDisplay"

if [[ ! -d "$MM_ROOT" ]]; then
    echo "MagicMirror not found at: $MM_ROOT" >&2
    echo "Pass the path as the first argument." >&2
    exit 1
fi
if [[ ! -d "$SOURCE_DIR" ]]; then
    echo "Module source not found at: $SOURCE_DIR" >&2
    exit 1
fi

mkdir -p "$MM_ROOT/modules"

# Best-effort cleanup of the old MMM-DoorCam symlink from before the rename.
OLD_LINK="$MM_ROOT/modules/MMM-DoorCam"
if [[ -L "$OLD_LINK" ]]; then
    echo "removing stale symlink: $OLD_LINK"
    rm "$OLD_LINK"
elif [[ -e "$OLD_LINK" ]]; then
    echo "WARNING: $OLD_LINK exists and is not a symlink — leaving it alone." >&2
    echo "         You can delete it manually if you no longer need it." >&2
fi

# New module symlink.
if [[ -L "$TARGET_LINK" ]]; then
    rm "$TARGET_LINK"
elif [[ -e "$TARGET_LINK" ]]; then
    echo "Refusing to overwrite existing non-symlink: $TARGET_LINK" >&2
    exit 1
fi
ln -s "$SOURCE_DIR" "$TARGET_LINK"
echo "linked: $TARGET_LINK -> $SOURCE_DIR"

cat <<EOF

==============================================================
 MMM-LuxSecurityDisplay installed.

 Next:
   1. Make sure the LuxSecurityHub is running somewhere reachable
      from this MagicMirror. To install it on this same Pi, run:
          ./hub/install.sh
      Or point the module at an existing hub via 'hubUrl'.

   2. Add the module to ~/MagicMirror/config/config.js:
          {
            module: "MMM-LuxSecurityDisplay",
            position: "bottom_right",
            config: {
              hubUrl: "http://meer.local:5000",
              camId: "front",
              title: "Door Cam"
            }
          }

   3. Restart MagicMirror.
==============================================================
EOF
