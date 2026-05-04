#!/usr/bin/env bash
# LuxSecurityHub — standalone hub installer.
#
# What it does (idempotent — safe to re-run for upgrades):
#   1. Sanity: Linux + systemd, Node.js >= 18, npm. Warn if ffmpeg is absent.
#   2. Self-elevate via sudo, capture $SUDO_USER as the service account.
#   3. npm install --omit=dev inside the hub/ checkout.
#   4. Bootstrap /etc/lux-security-hub/config.yml from config.example.yml
#      (only if absent — re-runs preserve user customization).
#   5. Generate /etc/systemd/system/lux-security-hub.service with the right
#      user + paths templated in.
#   6. systemctl daemon-reload + enable + restart, then verify.

set -euo pipefail

#--- pre-flight ---------------------------------------------------------------

case "$(uname -s)" in
    Linux*) ;;
    *)
        echo "ERROR: this installer targets Linux. Detected: $(uname -s)" >&2
        echo "On macOS / Windows, run the hub directly:  node src/hub.js" >&2
        exit 1
        ;;
esac

if ! command -v systemctl >/dev/null 2>&1; then
    echo "ERROR: systemctl not found. This installer requires systemd." >&2
    echo "Run the hub manually instead: node $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/src/hub.js" >&2
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: 'node' not on PATH. Install Node.js 18+:" >&2
    echo "    sudo apt install -y nodejs npm" >&2
    echo "    (or, for a newer release: see https://github.com/nodesource/distributions)" >&2
    exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [[ "$NODE_MAJOR" -lt 18 ]]; then
    echo "ERROR: Node.js >= 18 required (found $(node --version))." >&2
    echo "Upgrade with the NodeSource installer or use nvm." >&2
    exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: 'npm' not on PATH." >&2
    echo "Install: sudo apt install -y npm" >&2
    exit 1
fi

if [[ $EUID -ne 0 ]]; then
    echo "==> Elevating with sudo..."
    exec sudo -E bash "$0" "$@"
fi

TARGET_USER="${SUDO_USER:-}"
if [[ -z "$TARGET_USER" || "$TARGET_USER" == "root" ]]; then
    echo "ERROR: must be invoked via sudo from a regular user account." >&2
    echo "Try: ./hub/install.sh   (don't sudo it directly as root)" >&2
    exit 1
fi
TARGET_GROUP=$(id -gn "$TARGET_USER")

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$SCRIPT_DIR"
NODE_BIN="$(command -v node)"

if [[ ! -f "$INSTALL_DIR/package.json" ]]; then
    echo "ERROR: $INSTALL_DIR doesn't look like the hub/ checkout (no package.json)" >&2
    exit 1
fi

cat <<EOF
==============================================
 LuxSecurityHub — installer
----------------------------------------------
 Install dir:  $INSTALL_DIR
 Service user: $TARGET_USER ($TARGET_GROUP)
 Node:         $NODE_BIN ($(node --version))
==============================================

EOF

#--- 1. npm deps -------------------------------------------------------------

echo "==> Installing npm dependencies (onnxruntime-node, sharp, better-sqlite3, ws, js-yaml)..."
sudo -u "$TARGET_USER" --preserve-env=PATH bash -c "cd '$INSTALL_DIR' && npm install --omit=dev --no-audit --no-fund"

#--- 2. ffmpeg presence check ------------------------------------------------

if ! command -v ffmpeg >/dev/null 2>&1; then
    echo
    echo "WARNING: ffmpeg not found on PATH." >&2
    echo "  Install with: sudo apt install -y ffmpeg" >&2
    echo "  Without it, person events are still detected and logged but no" >&2
    echo "  video clip will be recorded." >&2
    echo
fi

#--- 3. config bootstrap -----------------------------------------------------

SYSTEM_CONFIG_DIR=/etc/lux-security-hub
SYSTEM_CONFIG_FILE="$SYSTEM_CONFIG_DIR/config.yml"
if [[ -f "$SYSTEM_CONFIG_FILE" ]]; then
    echo "==> Existing config at $SYSTEM_CONFIG_FILE — left untouched."
else
    echo "==> Bootstrapping $SYSTEM_CONFIG_FILE from config.example.yml..."
    mkdir -p "$SYSTEM_CONFIG_DIR"
    cp "$INSTALL_DIR/config.example.yml" "$SYSTEM_CONFIG_FILE"
    chmod 644 "$SYSTEM_CONFIG_FILE"
    echo "    Edit it later with:  sudoedit $SYSTEM_CONFIG_FILE"
fi

#--- 4. systemd unit ---------------------------------------------------------

SERVICE_FILE=/etc/systemd/system/lux-security-hub.service
echo "==> Writing systemd unit to $SERVICE_FILE..."
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=LuxSecurityHub — camera + detection + recording hub
Documentation=https://github.com/JaredLodwick/DoorCamera
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_GROUP
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/src/hub.js
Environment=LUXHUB_CONFIG=$SYSTEM_CONFIG_FILE
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

#--- 5. enable + start -------------------------------------------------------

echo "==> Reloading systemd and (re)starting lux-security-hub.service..."
systemctl daemon-reload
systemctl enable -q lux-security-hub
systemctl restart lux-security-hub

#--- 6. verify ---------------------------------------------------------------

sleep 3
echo
if systemctl is-active --quiet lux-security-hub; then
    echo "[OK] lux-security-hub.service is running."
    echo
    systemctl status lux-security-hub --no-pager --lines=5 || true
    echo
    cat <<EOF
----------------------------------------------
 Useful commands
----------------------------------------------
 Live logs:        journalctl -fu lux-security-hub
 Recent logs:      journalctl -u lux-security-hub -n 100 --no-pager
 Service status:   systemctl status lux-security-hub
 Restart:          sudo systemctl restart lux-security-hub
 Stop / disable:   sudo systemctl disable --now lux-security-hub
 Edit config:      sudoedit $SYSTEM_CONFIG_FILE   (then restart)

 Dashboard:        http://$(hostname).local:5000/
 Health check:     curl http://localhost:5000/healthz
EOF
else
    echo "[FAIL] lux-security-hub.service is not running. Recent logs:" >&2
    journalctl -u lux-security-hub -n 50 --no-pager >&2
    exit 1
fi
