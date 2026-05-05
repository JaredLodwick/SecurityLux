#!/usr/bin/env bash
# LuxSecurityCamera — unified installer.
#
# This installs ONE of the three components on the current device:
#
#   1) hub       central server (HTTP+WS, detection, recording, dashboard)
#   2) camera    Pi-side WebSocket publisher with a USB webcam
#   3) viewer    optional MagicMirror² display module
#
# Walks the user through component selection, asks the small handful of
# config questions that actually matter, then delegates to the matching
# component installer (`hub/install.sh`, `camera_node/install.sh`,
# `mm_module/install.sh`). After a successful install it offers to remove
# the other two component directories so the on-device checkout only
# carries what's actually running.
#
# To install multiple components on the same machine (e.g., a MagicMirror
# Pi acting as both hub and viewer), re-clone the repo and run the
# installer once per component.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

#--- helpers ------------------------------------------------------------------

prompt_default () {
    # prompt_default "Question" "default value"  →  echoes the answer
    local prompt="$1" default="$2" input
    read -rp "$prompt [$default]: " input
    echo "${input:-$default}"
}

confirm () {
    # confirm "Question? [Y/n]"  →  exits 0 on yes (default Y), 1 on no
    local prompt="$1" default="${2:-Y}" input
    read -rp "$prompt: " input
    input="${input:-$default}"
    [[ "$input" =~ ^[Yy]$ ]]
}

expand_tilde () {
    # Bash doesn't expand ~ inside quoted variables; do it ourselves.
    local p="$1"
    echo "${p/#\~/$HOME}"
}

require_dir () {
    local dir="$1" name="$2"
    if [[ ! -d "$REPO_DIR/$dir" ]]; then
        echo "ERROR: missing $dir/ — this checkout doesn't have the $name component." >&2
        echo "       Did you previously run install.sh and let it clean up?" >&2
        echo "       If so, re-clone the repo and try again." >&2
        exit 1
    fi
}

#--- pre-flight ---------------------------------------------------------------

if [[ $EUID -eq 0 ]]; then
    echo "ERROR: don't run this installer with sudo directly." >&2
    echo "       Run it as your normal user; sub-installers will self-elevate as needed." >&2
    exit 1
fi

# Sanity: we're running from a real LuxSecurityCamera checkout.
if [[ ! -d "$REPO_DIR/hub" && ! -d "$REPO_DIR/camera_node" && ! -d "$REPO_DIR/mm_module" ]]; then
    echo "ERROR: $REPO_DIR doesn't look like a LuxSecurityCamera checkout." >&2
    echo "       Expected one or more of: hub/, camera_node/, mm_module/" >&2
    exit 1
fi

#--- banner -------------------------------------------------------------------

cat <<'EOF'
=============================================================
 LuxSecurityCamera installer
=============================================================
 Pick ONE component to install on this device.

 Running both the hub and the MagicMirror display on the same
 Pi is a common setup — re-run this installer afterwards and
 pick the other one. The installer leaves both packages on
 disk for that case so you don't have to re-clone the repo.

EOF

#--- 1. component selection ---------------------------------------------------

cat <<'EOF'
Which component do you want to install?

  1) hub      The central server. Receives streams from all camera
              nodes, runs person detection, records clips, serves the
              dashboard. ONE per network. Runs on Linux (Pi 4/5, NUC,
              desktop) or macOS (Apple Silicon or Intel). Needs
              Node.js 18+. Windows: see hub/README.md for manual
              install.

  2) camera   A camera publisher. Runs on a Raspberry Pi at a doorway
              with a USB webcam. Pi Zero 2 W works great. ONE per
              camera. Needs Python 3.11+.

  3) viewer   Optional MagicMirror² module that displays one camera on
              your mirror. Pure browser-side; needs MagicMirror to be
              already installed on this device.

EOF

read -rp "Enter 1, 2, or 3: " CHOICE
echo

case "$CHOICE" in
    1|hub)            COMPONENT="hub" ;;
    2|camera|cam|camera_node)    COMPONENT="camera" ;;
    3|viewer|mm|mm_module)       COMPONENT="viewer" ;;
    *)
        echo "ERROR: invalid choice '$CHOICE' — expected 1, 2, or 3." >&2
        exit 1
        ;;
esac

#--- 2. component-specific questions + install --------------------------------

HUB_URL=""              # used by camera + viewer
CAM_ID=""               # used by camera + viewer
MM_PATH=""              # used by viewer only

case "$COMPONENT" in

    hub)
        require_dir hub "hub"
        echo "==> Installing the hub. The sub-installer will ask for your sudo password."
        echo
        bash "$REPO_DIR/hub/install.sh"
        ;;

    camera)
        require_dir camera_node "camera"
        HUB_URL=$(prompt_default "Hub WebSocket URL" "ws://meer.local:5000")
        CAM_ID=$(prompt_default  "Camera ID" "front")
        echo
        echo "==> Writing /etc/camera-node/config.yml (sudo)..."
        sudo mkdir -p /etc/camera-node
        sudo tee /etc/camera-node/config.yml >/dev/null <<EOF
# Generated by LuxSecurityCamera install.sh.
# Edit anytime; restart with: sudo systemctl restart camera-node

hub:
  url: $HUB_URL

camera:
  id: $CAM_ID
  device: /dev/video0
  resolution: [640, 480]
  fps: 15
  jpeg_quality: 70

pisugar:
  host: 127.0.0.1
  port: 8423
  timeout_seconds: 1.0

logging:
  level: INFO
EOF
        echo "    wrote /etc/camera-node/config.yml"
        echo
        echo "==> Running camera_node/install.sh..."
        bash "$REPO_DIR/camera_node/install.sh"
        ;;

    viewer)
        require_dir mm_module "viewer"
        MM_PATH=$(prompt_default "MagicMirror install path" "$HOME/MagicMirror")
        MM_PATH=$(expand_tilde "$MM_PATH")
        if [[ ! -d "$MM_PATH" ]]; then
            cat >&2 <<EOF

ERROR: MagicMirror not found at: $MM_PATH

The viewer is a MagicMirror² module — MagicMirror must be installed
on this device first. Install it with:

    https://docs.magicmirror.builders/getting-started/installation.html

Then re-run this installer.
EOF
            exit 1
        fi
        if [[ ! -d "$MM_PATH/modules" ]]; then
            echo "ERROR: $MM_PATH exists but has no modules/ subdirectory — that's not a MagicMirror install." >&2
            exit 1
        fi
        HUB_URL=$(prompt_default "Hub URL the module should poll" "http://meer.local:5000")
        CAM_ID=$(prompt_default  "Camera ID to display"           "front")
        echo
        echo "==> Symlinking MMM-LuxSecurityDisplay into MagicMirror..."
        bash "$REPO_DIR/mm_module/install.sh" "$MM_PATH"
        ;;

esac

#--- 3. cleanup ---------------------------------------------------------------
#
# Only the camera_node ever lives in isolation — that hardware (a Pi Zero
# with a USB webcam) doesn't sensibly host the hub or the MagicMirror
# display. Hub-vs-viewer is a different story: the most common deployment
# is a single MagicMirror Pi running BOTH the hub (as a separate service)
# AND the viewer (as a MagicMirror module). We keep both packages on disk
# so the user can re-run `./install.sh` later and pick the other one
# without re-cloning.

case "$COMPONENT" in
    hub|viewer)
        # Both hub and viewer live on the same kind of machine (a regular
        # Linux/macOS host). Keep each other's directories around.
        OTHERS=("camera_node")
        ;;
    camera)
        # A camera_node is dedicated hardware — neither the hub nor the
        # viewer have any business running on a Pi Zero with a webcam.
        OTHERS=("hub" "mm_module")
        ;;
esac

# Only offer to remove dirs that actually exist (re-runs may already have
# pruned some).
existing=()
for dir in "${OTHERS[@]}"; do
    [[ -d "$REPO_DIR/$dir" ]] && existing+=("$dir")
done

if (( ${#existing[@]} > 0 )); then
    echo
    echo "----------------------------------------------"
    echo " Cleanup"
    echo "----------------------------------------------"
    case "$COMPONENT" in
        hub)
            echo "This is a hub install. The camera_node package isn't needed here"
            echo "(it only runs on a Pi with an attached USB webcam)."
            echo
            echo "The mm_module/ directory is left in place so you can re-run"
            echo "./install.sh later to add the MagicMirror display on this same"
            echo "machine without re-cloning the repo."
            ;;
        viewer)
            echo "This is a viewer install. The camera_node package isn't needed"
            echo "here (it only runs on a Pi with an attached USB webcam)."
            echo
            echo "The hub/ directory is left in place so you can re-run"
            echo "./install.sh later to also run the hub on this same machine"
            echo "without re-cloning the repo."
            ;;
        camera)
            echo "This is a camera_node install. Neither the hub nor the viewer"
            echo "package belongs on a dedicated camera Pi."
            ;;
    esac
    echo
    echo "Remove the following director$([[ ${#existing[@]} -eq 1 ]] && echo "y" || echo "ies") from this checkout:"
    for dir in "${existing[@]}"; do
        echo "    $REPO_DIR/$dir"
    done
    echo
    if confirm "Remove now? [Y/n]"; then
        for dir in "${existing[@]}"; do
            rm -rf "${REPO_DIR:?}/$dir"
            echo "    removed $dir/"
        done
    else
        echo "    skipped — left in place. (You can delete them by hand later.)"
    fi
fi

#--- 4. next steps ------------------------------------------------------------

# Best-effort hostname for the URL. Falls back to localhost if the host has
# no .local advertisement.
host_short=$(hostname -s 2>/dev/null || hostname)
host_local="${host_short}.local"
hub_dashboard_default="http://${host_local}:5000/"

echo
echo "============================================================="
echo " Done."
echo "============================================================="

case "$COMPONENT" in

    hub)
        cat <<EOF

The hub is running as the systemd service 'lux-security-hub'.

Open the dashboard from any device on your LAN:
    $hub_dashboard_default
    (or http://localhost:5000/ from this machine)

It'll be empty until at least one camera_node connects. Set those
up next on whichever Pis hold your cameras (run this installer there
and pick option 2).

Person detection is OFF by default. To turn it on:
    - via the dashboard: flip the "Detection" toggle in the header
    - via the CLI:
          curl -X POST -H 'Content-Type: application/json' \\
               -d '{"enabled":true}' http://localhost:5000/detection

Logs:           journalctl -fu lux-security-hub
Config:         sudoedit /etc/lux-security-hub/config.yml
                (then: sudo systemctl restart lux-security-hub)

If you ALSO want to display a camera on a MagicMirror running on this
same machine, just re-run this installer and pick option 3 (viewer):
    cd $REPO_DIR && ./install.sh
EOF
        ;;

    camera)
        # Derive the dashboard URL from the WS URL the user picked.
        # ws://host:5000 → http://host:5000/
        dashboard_from_hub=$(echo "$HUB_URL" | sed -e 's|^ws://|http://|' -e 's|^wss://|https://|' -e 's|/cam.*$||' -e 's|/*$||')/
        cat <<EOF

The camera_node is running as the systemd service 'camera-node',
publishing to $HUB_URL as cam_id "$CAM_ID".

Verify it connected:
    journalctl -fu camera-node
Look for:
    "Connecting to hub at ${HUB_URL}/cam/${CAM_ID}"
    "Hub requested state=on"

Open the hub's dashboard to see the live feed + recorded events:
    $dashboard_from_hub

Logs:           journalctl -fu camera-node
Config:         sudoedit /etc/camera-node/config.yml
                (then: sudo systemctl restart camera-node)
EOF
        ;;

    viewer)
        cat <<EOF

The MMM-LuxSecurityDisplay module is symlinked into MagicMirror at:
    $MM_PATH/modules/MMM-LuxSecurityDisplay

Add this entry to your MagicMirror config and restart MM:

    sudoedit $MM_PATH/config/config.js

Inside the modules: [ ... ] array, paste:

    {
        module: "MMM-LuxSecurityDisplay",
        position: "bottom_right",
        config: {
            hubUrl: "$HUB_URL",
            camId: "$CAM_ID",
            title: "Door Cam"
        }
    },

Then restart MagicMirror.

If this same machine should ALSO run the hub itself, just re-run this
installer and pick option 1 (hub):
    cd $REPO_DIR && ./install.sh

You can browse all cameras + recorded events in the hub's dashboard:
    $HUB_URL
EOF
        ;;

esac

echo
