#!/usr/bin/env bash
# Door Cam — Pi client installer.
#
# What it does (idempotent — safe to re-run for upgrades):
#   1. Sanity-checks: Linux + systemd
#   2. Installs apt deps from apt-requirements.txt
#   3. Adds the running user to the `video` group (for /dev/video0)
#   4. Creates a Python venv and installs requirements.txt
#   5. Bootstraps /etc/doorcam/config.yml from config.example.yml (only if absent)
#   6. Renders a systemd unit (doorcam.service) with this user + this path
#   7. systemctl daemon-reload + enable + restart
#   8. Verifies the service came up; prints next steps
#
# Usage (from the cloned repo on the camera Pi):
#     ./pi_client/install.sh
# It will re-exec itself under sudo if you didn't start it that way.

set -euo pipefail

#--- pre-flight ----------------------------------------------------------------

case "$(uname -s)" in
    Linux*) ;;
    *)
        echo "ERROR: this installer targets Linux (Raspberry Pi OS). Detected: $(uname -s)" >&2
        exit 1
        ;;
esac

if ! command -v systemctl >/dev/null 2>&1; then
    echo "ERROR: systemctl not found. This installer requires systemd." >&2
    echo "Run the publisher manually instead:" >&2
    echo "    cd \"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)\" && .venv/bin/python -m doorcam" >&2
    exit 1
fi

# Self-elevate. Preserves the original user via $SUDO_USER.
if [[ $EUID -ne 0 ]]; then
    echo "==> Elevating with sudo..."
    exec sudo -E bash "$0" "$@"
fi

TARGET_USER="${SUDO_USER:-}"
if [[ -z "$TARGET_USER" || "$TARGET_USER" == "root" ]]; then
    echo "ERROR: must be invoked via sudo from a regular user account." >&2
    echo "Try: ./pi_client/install.sh   (don't sudo it directly as root)" >&2
    exit 1
fi
TARGET_GROUP=$(id -gn "$TARGET_USER")
TARGET_HOME=$(getent passwd "$TARGET_USER" | cut -d: -f6)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$SCRIPT_DIR"
VENV_DIR="$INSTALL_DIR/.venv"

if [[ ! -f "$INSTALL_DIR/requirements.txt" ]]; then
    echo "ERROR: $INSTALL_DIR doesn't look like a pi_client checkout (no requirements.txt)" >&2
    exit 1
fi

# Make sure the install dir is readable by the target user. If they cloned
# under their own home dir, this is automatic. If somebody put it under /opt
# owned by root, fix ownership of just the venv-relevant pieces.
if ! sudo -u "$TARGET_USER" test -r "$INSTALL_DIR/requirements.txt"; then
    echo "ERROR: $TARGET_USER cannot read $INSTALL_DIR/requirements.txt" >&2
    echo "       Re-clone the repo into a directory owned by $TARGET_USER, or chown it." >&2
    exit 1
fi

cat <<EOF
==============================================
 Door Cam — Pi client installer
----------------------------------------------
 Install dir:  $INSTALL_DIR
 Service user: $TARGET_USER ($TARGET_GROUP)
 Venv:         $VENV_DIR
==============================================

EOF

#--- 1. apt deps ---------------------------------------------------------------

APT_REQ="$INSTALL_DIR/apt-requirements.txt"
if [[ -f "$APT_REQ" ]]; then
    echo "==> Installing apt dependencies..."
    # shellcheck disable=SC2046
    APT_PACKAGES=$(grep -v '^[[:space:]]*#' "$APT_REQ" | grep -v '^[[:space:]]*$' | tr '\n' ' ')
    if [[ -n "$APT_PACKAGES" ]]; then
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $APT_PACKAGES
    fi
else
    echo "==> No apt-requirements.txt — skipping apt step."
fi

#--- 2. video group ------------------------------------------------------------

if id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx video; then
    echo "==> $TARGET_USER already in 'video' group."
else
    echo "==> Adding $TARGET_USER to 'video' group (for /dev/video0 access)..."
    usermod -aG video "$TARGET_USER"
    echo "    NOTE: $TARGET_USER may need to log out/in for the group change to take effect"
    echo "          in interactive shells. The systemd service picks it up immediately."
fi

#--- 3. python venv + pip deps -------------------------------------------------

if [[ ! -d "$VENV_DIR" ]]; then
    echo "==> Creating Python venv at $VENV_DIR..."
    sudo -u "$TARGET_USER" python3 -m venv "$VENV_DIR"
else
    echo "==> Reusing existing venv at $VENV_DIR."
fi

echo "==> Installing pip dependencies (slow on Pi Zero — give it a few minutes)..."
sudo -u "$TARGET_USER" "$VENV_DIR/bin/pip" install --upgrade pip --quiet
sudo -u "$TARGET_USER" "$VENV_DIR/bin/pip" install -r "$INSTALL_DIR/requirements.txt" --quiet

#--- 4. config bootstrap -------------------------------------------------------

SYSTEM_CONFIG_DIR=/etc/doorcam
SYSTEM_CONFIG_FILE="$SYSTEM_CONFIG_DIR/config.yml"
if [[ -f "$SYSTEM_CONFIG_FILE" ]]; then
    echo "==> Existing config at $SYSTEM_CONFIG_FILE — left untouched."
else
    echo "==> Bootstrapping $SYSTEM_CONFIG_FILE from config.example.yml..."
    mkdir -p "$SYSTEM_CONFIG_DIR"
    cp "$INSTALL_DIR/config.example.yml" "$SYSTEM_CONFIG_FILE"
    chmod 644 "$SYSTEM_CONFIG_FILE"
    echo "    If your hub isn't at ws://meer.local:5000, edit it:"
    echo "        sudoedit $SYSTEM_CONFIG_FILE"
fi

#--- 5. systemd unit -----------------------------------------------------------

SERVICE_FILE=/etc/systemd/system/doorcam.service
echo "==> Writing systemd unit to $SERVICE_FILE..."
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Door Cam Pi Client (WebSocket publisher to the MagicMirror hub)
Documentation=https://github.com/JaredLodwick/DoorCamera
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_GROUP
WorkingDirectory=$INSTALL_DIR
ExecStart=$VENV_DIR/bin/python -m doorcam
Environment=DOORCAM_CONFIG=$SYSTEM_CONFIG_FILE

# Auto-restart on crash, with a small backoff so we don't hammer the CPU
# when the install is fundamentally broken (e.g. webcam unplugged).
Restart=on-failure
RestartSec=3

# Light hardening. ProtectHome is intentionally off so installs under the
# user's home dir keep working (the venv may live in $TARGET_HOME).
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

#--- 6. enable + start ---------------------------------------------------------

echo "==> Reloading systemd and (re)starting doorcam.service..."
systemctl daemon-reload
systemctl enable -q doorcam
systemctl restart doorcam

#--- 7. verify -----------------------------------------------------------------

# Give the publisher a moment to either connect or fail.
sleep 3

echo
if systemctl is-active --quiet doorcam; then
    echo "[OK] doorcam.service is running."
    echo
    echo "Live status:"
    systemctl status doorcam --no-pager --lines=5 || true
    echo
    cat <<EOF
----------------------------------------------
 Useful commands
----------------------------------------------
 Live logs:        journalctl -fu doorcam
 Recent logs:      journalctl -u doorcam -n 100 --no-pager
 Service status:   systemctl status doorcam
 Restart:          sudo systemctl restart doorcam
 Stop / disable:   sudo systemctl disable --now doorcam
 Edit config:      sudoedit $SYSTEM_CONFIG_FILE   (then restart)
EOF
else
    echo "[FAIL] doorcam.service is not running. Recent logs:" >&2
    journalctl -u doorcam -n 50 --no-pager >&2
    exit 1
fi
