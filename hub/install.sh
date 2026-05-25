#!/usr/bin/env bash
# SecurityLuxHub — standalone hub installer.
#
# Cross-OS: Linux (systemd) and macOS (launchd LaunchAgent). Windows users
# install manually — see hub/README.md "Windows" section.
#
# Idempotent — safe to re-run for upgrades.
#
# What it does:
#   1. Sanity-check Node.js >= 18, npm. Warn if ffmpeg is missing.
#   2. npm install --omit=dev inside hub/.
#   3. Bootstrap a config.yml at the platform-appropriate path.
#   4. Register the hub as an OS service:
#        Linux  → /etc/systemd/system/security-lux-hub.service
#        macOS  → ~/Library/LaunchAgents/com.securityluxhub.plist
#   5. Start it; verify; print useful commands.

set -euo pipefail

#--- detect OS ----------------------------------------------------------------

OS_KERNEL="$(uname -s)"
case "$OS_KERNEL" in
    Linux*)   OS="linux" ;;
    Darwin*)  OS="macos" ;;
    *)
        cat >&2 <<EOF
ERROR: this installer doesn't support $OS_KERNEL automatically.

For Windows, see hub/README.md "Windows" — short version:
    git clone … && cd hub && npm install
    node src/hub.js                       # foreground
    # or register as a Windows Service via NSSM (documented in README)

For other Unixes you can probably run the hub directly:
    cd $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    npm install
    node src/hub.js
EOF
        exit 1
        ;;
esac

#--- common pre-flight --------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
    cat >&2 <<EOF
ERROR: 'node' not on PATH. Install Node.js 18+ first.

  Linux:  sudo apt install -y nodejs npm
          (or, for newer: https://github.com/nodesource/distributions)
  macOS:  brew install node
EOF
    exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [[ "$NODE_MAJOR" -lt 18 ]]; then
    echo "ERROR: Node.js >= 18 required (found $(node --version))." >&2
    exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: 'npm' not on PATH." >&2
    exit 1
fi

NODE_BIN="$(command -v node)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$SCRIPT_DIR"

if [[ ! -f "$INSTALL_DIR/package.json" ]]; then
    echo "ERROR: $INSTALL_DIR doesn't look like the hub/ checkout (no package.json)" >&2
    exit 1
fi

#--- pre-flight: detect existing hubs ----------------------------------------
#
# Two checks before we touch anything on disk:
#   1. Probe localhost:5000 — catches re-installs on the same machine. The
#      right answer here is almost always "yes, continue" (the installer is
#      idempotent and preserves config + DB), so we encourage it.
#   2. Ask whether the user already has a hub elsewhere on the network. If
#      yes, probe their URL and walk them through migration / recovery /
#      both-intentional scenarios so they don't blindly stand up a second
#      hub when the right move is "fix the existing one."
#
# Skipped on the second pass after `exec sudo` (Linux), so the user is only
# prompted once per install attempt.

probe_hub () {
    # Returns 0 iff the URL responds like a SecurityLuxHub.
    # Two-shot probe: /healthz returns "ok" AND /cams returns a JSON array.
    # Stronger than just /healthz so we don't false-positive on random
    # services that happen to expose /healthz.
    local url="$1" healthz cams
    command -v curl >/dev/null 2>&1 || return 1
    healthz=$(curl -fs --max-time 2 "$url/healthz" 2>/dev/null) || return 1
    [[ "$healthz" == "ok" ]] || return 1
    cams=$(curl -fs --max-time 2 "$url/cams" 2>/dev/null) || return 1
    [[ "$cams" == \[* ]] || return 1
    return 0
}

guess_existing_hub_port () {
    # If a config file already exists from a prior install, use its hub.port.
    # Otherwise default to 5000. We don't pull in a YAML parser — a tiny
    # awk regex against `port: <n>` under the `hub:` block is fine.
    local cfg
    for cfg in "$HOME/.config/securityluxhub/config.yml" "/etc/security-lux-hub/config.yml" "$HOME/.config/luxsecurityhub/config.yml" "/etc/lux-security-hub/config.yml"; do
        if [[ -r "$cfg" ]]; then
            local port
            port=$(awk '
                /^hub:/ { in_hub = 1; next }
                /^[^[:space:]]/ { in_hub = 0 }
                in_hub && /^[[:space:]]+port:/ {
                    gsub(/[^0-9]/, "")
                    print
                    exit
                }
            ' "$cfg")
            if [[ "$port" =~ ^[0-9]+$ ]]; then
                echo "$port"
                return
            fi
        fi
    done
    echo 5000
}

confirm_default () {
    # confirm_default "Question" "Y|N"  →  exits 0 on Y-equivalent answer.
    local prompt="$1" default="${2:-Y}" input
    read -rp "$prompt: " input
    input="${input:-$default}"
    [[ "$input" =~ ^[Yy]$ ]]
}

run_preflight_existing_hub_checks () {
    if [[ -n "${SECURITY_LUX_PREFLIGHT_DONE:-}" ]]; then return 0; fi

    # 1. localhost probe — re-install case
    local local_port; local_port=$(guess_existing_hub_port)
    local local_url="http://localhost:${local_port}"
    if probe_hub "$local_url"; then
        cat <<EOF

==============================================================
 Existing hub detected on this machine
==============================================================
A SecurityLuxHub is already running at $local_url/.
This looks like a re-install — which is the right move for almost
every problem you might be having:

  * The installer is idempotent. Re-running it rewrites the systemd
    unit / LaunchAgent and restarts the service.
  * Your existing config (~/.config/securityluxhub/config.yml or
    /etc/security-lux-hub/config.yml) is left untouched, so your
    customizations survive.
  * The events database and recorded clips are preserved.

If the hub is misbehaving, before re-installing it's worth peeking at
the logs first:
    Linux:  journalctl -fu security-lux-hub
    macOS:  tail -f ~/Library/Logs/SecurityLuxHub.err.log

EOF
        if ! confirm_default "Continue with re-install? [Y/n]" "Y"; then
            echo "Aborted — nothing changed."
            exit 0
        fi
    fi

    # 2. cross-network probe — second-hub case
    echo
    local has_remote
    read -rp "Do you already have a hub running on ANOTHER machine on your network? [y/N]: " has_remote
    if [[ "$has_remote" =~ ^[Yy]$ ]]; then
        local remote_url
        read -rp "What's its URL? [http://meer.local:5000]: " remote_url
        remote_url="${remote_url:-http://meer.local:5000}"
        echo "==> Probing $remote_url ..."
        if probe_hub "$remote_url"; then
            cat <<EOF

Confirmed: a SecurityLuxHub is responding at $remote_url

You're about to install a SECOND hub on this network. Three reasons
people end up doing this — pick the one that fits, then decide.

  ▸ MIGRATING hardware (e.g., moving from old Pi to new desktop):
    Install here, then update each camera_node's config to point at
    this new host:
        sudoedit /etc/camera-node/config.yml
    Set 'hub.url' to ws://<this-host>:5000. Then stop the old hub:
        ssh user@old-host 'sudo systemctl disable --now security-lux-hub'   # Linux
        ssh user@old-host 'launchctl unload ~/Library/LaunchAgents/com.securityluxhub.plist'   # macOS
    Don't forget to also update your MagicMirror module's hubUrl, if
    you use it.

  ▸ RECOVERING from a broken install:
    Stop. The hub installer is idempotent — re-running it on the old
    machine almost always fixes things. Most "broken hub" symptoms
    are config-related, not install-corruption. Try:
        ssh user@old-host 'cd ~/SecurityLux && git pull && ./hub/install.sh'
    Check logs first if it's still broken:
        ssh user@old-host 'journalctl -fu security-lux-hub'   # Linux
        ssh user@old-host 'tail -f ~/Library/Logs/SecurityLuxHub.err.log'   # macOS

  ▸ Running BOTH intentionally:
    Technically supported. Each camera_node connects to exactly one
    hub. Clip storage and the events database are NOT shared between
    hubs. You'll be managing two completely independent setups.

EOF
            if ! confirm_default "Continue installing a second hub on this machine? [y/N]" "N"; then
                echo "Aborted — nothing changed."
                exit 0
            fi
        else
            echo "  Couldn't reach a hub at $remote_url — proceeding anyway."
            echo "  (Maybe the URL is wrong, or the old hub is offline.)"
        fi
    fi

    export SECURITY_LUX_PREFLIGHT_DONE=1
}

run_preflight_existing_hub_checks

#============================================================================
# LINUX  — systemd
#============================================================================

install_linux () {
    if ! command -v systemctl >/dev/null 2>&1; then
        echo "ERROR: systemctl not found. This installer requires systemd on Linux." >&2
        echo "Run the hub manually instead: node $INSTALL_DIR/src/hub.js" >&2
        exit 1
    fi

    if [[ $EUID -ne 0 ]]; then
        echo "==> Elevating with sudo..."
        exec sudo -E bash "$0" "$@"
    fi

    local target_user="${SUDO_USER:-}"
    if [[ -z "$target_user" || "$target_user" == "root" ]]; then
        echo "ERROR: must be invoked via sudo from a regular user account." >&2
        echo "Try: ./hub/install.sh   (don't sudo it directly as root)" >&2
        exit 1
    fi
    local target_group; target_group=$(id -gn "$target_user")

    cat <<EOF
==============================================
 SecurityLuxHub — installer (Linux / systemd)
----------------------------------------------
 Install dir:  $INSTALL_DIR
 Service user: $target_user ($target_group)
 Node:         $NODE_BIN ($(node --version))
==============================================

EOF

    echo "==> Installing npm dependencies..."
    sudo -u "$target_user" --preserve-env=PATH bash -c "cd '$INSTALL_DIR' && npm install --omit=dev --no-audit --no-fund"

    if ! command -v ffmpeg >/dev/null 2>&1; then
        echo
        echo "WARNING: ffmpeg not found on PATH. Recording is disabled." >&2
        echo "  Install with: sudo apt install -y ffmpeg" >&2
        echo
    fi

    local cfg_dir=/etc/security-lux-hub
    local cfg_file="$cfg_dir/config.yml"
    local legacy_cfg_file=/etc/lux-security-hub/config.yml
    if [[ -f "$cfg_file" ]]; then
        echo "==> Existing config at $cfg_file — left untouched."
    elif [[ -f "$legacy_cfg_file" ]]; then
        echo "==> Migrating config from $legacy_cfg_file to $cfg_file..."
        mkdir -p "$cfg_dir"
        cp "$legacy_cfg_file" "$cfg_file"
        chmod 644 "$cfg_file"
        echo "    Edit later with:  sudoedit $cfg_file"
    else
        echo "==> Bootstrapping $cfg_file from config.example.yml..."
        mkdir -p "$cfg_dir"
        cp "$INSTALL_DIR/config.example.yml" "$cfg_file"
        chmod 644 "$cfg_file"
        echo "    Edit later with:  sudoedit $cfg_file"
    fi

    local service_file=/etc/systemd/system/security-lux-hub.service
    echo "==> Writing systemd unit to $service_file..."
    cat > "$service_file" <<EOF
[Unit]
Description=SecurityLuxHub — camera + detection + recording hub
Documentation=https://github.com/JaredLodwick/SecurityLux
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$target_user
Group=$target_group
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/src/hub.js
Environment=SECURITY_LUX_HUB_CONFIG=$cfg_file
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

    if systemctl list-unit-files --type=service --no-legend lux-security-hub.service 2>/dev/null | grep -q '^lux-security-hub\.service'; then
        echo "==> Disabling legacy lux-security-hub.service..."
        systemctl disable --now lux-security-hub 2>/dev/null || true
    fi

    echo "==> Reloading systemd and (re)starting security-lux-hub.service..."
    systemctl daemon-reload
    systemctl enable -q security-lux-hub
    systemctl restart security-lux-hub

    sleep 3
    echo
    if systemctl is-active --quiet security-lux-hub; then
        echo "[OK] security-lux-hub.service is running."
        echo
        systemctl status security-lux-hub --no-pager --lines=5 || true
        echo
        cat <<EOF
----------------------------------------------
 Useful commands
----------------------------------------------
 Live logs:        journalctl -fu security-lux-hub
 Recent logs:      journalctl -u security-lux-hub -n 100 --no-pager
 Service status:   systemctl status security-lux-hub
 Restart:          sudo systemctl restart security-lux-hub
 Stop / disable:   sudo systemctl disable --now security-lux-hub
 Edit config:      sudoedit $cfg_file   (then restart)

 Dashboard:        http://$(hostname).local:5000/
 Health check:     curl http://localhost:5000/healthz
EOF
    else
        echo "[FAIL] security-lux-hub.service is not running. Recent logs:" >&2
        journalctl -u security-lux-hub -n 50 --no-pager >&2
        exit 1
    fi
}

#============================================================================
# macOS  — launchd LaunchAgent
#============================================================================

install_macos () {
    if [[ $EUID -eq 0 ]]; then
        echo "ERROR: don't run with sudo on macOS — the LaunchAgent is per-user." >&2
        echo "       Run as your normal user: ./hub/install.sh" >&2
        exit 1
    fi

    local target_user; target_user=$(id -un)
    local target_home; target_home="$HOME"
    local plist_label="com.securityluxhub"
    local legacy_plist_label="com.luxsecurityhub"
    local plist_dir="$target_home/Library/LaunchAgents"
    local plist_path="$plist_dir/$plist_label.plist"
    local legacy_plist_path="$plist_dir/$legacy_plist_label.plist"

    # User-level config and logs — no sudo needed for any of this.
    local cfg_dir="$target_home/.config/securityluxhub"
    local cfg_file="$cfg_dir/config.yml"
    local legacy_cfg_file="$target_home/.config/luxsecurityhub/config.yml"
    local log_dir="$target_home/Library/Logs"
    local log_out="$log_dir/SecurityLuxHub.log"
    local log_err="$log_dir/SecurityLuxHub.err.log"

    cat <<EOF
==============================================
 SecurityLuxHub — installer (macOS / launchd)
----------------------------------------------
 Install dir:  $INSTALL_DIR
 Service user: $target_user (LaunchAgent — user level)
 Node:         $NODE_BIN ($(node --version))
 Config:       $cfg_file
 Logs:         $log_out
==============================================

EOF

    echo "==> Installing npm dependencies..."
    ( cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund )

    if ! command -v ffmpeg >/dev/null 2>&1; then
        echo
        echo "WARNING: ffmpeg not found on PATH. Recording is disabled." >&2
        echo "  Install with: brew install ffmpeg" >&2
        echo
    fi

    if [[ -f "$cfg_file" ]]; then
        echo "==> Existing config at $cfg_file — left untouched."
    elif [[ -f "$legacy_cfg_file" ]]; then
        echo "==> Migrating config from $legacy_cfg_file to $cfg_file..."
        mkdir -p "$cfg_dir"
        cp "$legacy_cfg_file" "$cfg_file"
        chmod 644 "$cfg_file"
        echo "    Edit later with your editor of choice."
    else
        echo "==> Bootstrapping $cfg_file from config.example.yml..."
        mkdir -p "$cfg_dir"
        cp "$INSTALL_DIR/config.example.yml" "$cfg_file"
        chmod 644 "$cfg_file"
        echo "    Edit later with your editor of choice."
    fi

    mkdir -p "$plist_dir" "$log_dir"

    # If the agent is already loaded from a previous run, unload it so
    # we can swap the plist cleanly.
    if launchctl list | awk '{print $3}' | grep -qx "$plist_label"; then
        echo "==> Unloading existing LaunchAgent..."
        launchctl unload "$plist_path" 2>/dev/null || true
    fi
    if launchctl list | awk '{print $3}' | grep -qx "$legacy_plist_label"; then
        echo "==> Unloading legacy LaunchAgent..."
        launchctl remove "$legacy_plist_label" 2>/dev/null || launchctl unload "$legacy_plist_path" 2>/dev/null || true
    fi

    echo "==> Writing LaunchAgent plist to $plist_path..."
    # PATH for launchd's minimal env: include both Intel and Apple Silicon
    # Homebrew prefixes so ffmpeg (and any other brew-installed binary the
    # hub may shell out to) is findable from the daemon.
    cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$plist_label</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$INSTALL_DIR/src/hub.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>SECURITY_LUX_HUB_CONFIG</key>
        <string>$cfg_file</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>

    <key>StandardOutPath</key>
    <string>$log_out</string>

    <key>StandardErrorPath</key>
    <string>$log_err</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
EOF

    echo "==> Loading LaunchAgent..."
    launchctl load -w "$plist_path"

    sleep 2
    echo
    if launchctl list | awk '{print $3}' | grep -qx "$plist_label"; then
        local pid; pid=$(launchctl list | awk -v lbl="$plist_label" '$3==lbl {print $1}')
        if [[ "$pid" =~ ^[0-9]+$ ]]; then
            echo "[OK] $plist_label is running (pid $pid)."
        else
            echo "[OK] $plist_label is registered (not yet running — check logs)."
        fi
        echo
        cat <<EOF
----------------------------------------------
 Useful commands
----------------------------------------------
 Live logs (stdout):  tail -f $log_out
 Live logs (stderr):  tail -f $log_err
 Service status:      launchctl list $plist_label
 Stop now:            launchctl unload $plist_path
 Start (after stop):  launchctl load -w $plist_path
 Edit config:         \${EDITOR:-vi} $cfg_file
                      (then: launchctl unload $plist_path && launchctl load -w $plist_path)

 Dashboard:           http://$(hostname -s).local:5000/   (or http://localhost:5000/)
 Health check:        curl http://localhost:5000/healthz

 NOTE 1: this is a LaunchAgent — it runs while you're logged in. macOS
   typically auto-logs-in your account on boot, so the hub comes back
   after a restart. For "boot before login" behavior, install as a
   LaunchDaemon under /Library/LaunchDaemons/ instead (requires sudo).

 NOTE 2: macOS ships an AirPlay Receiver on port 5000. If the hub log
   shows "EADDRINUSE: address already in use 0.0.0.0:5000", either turn
   AirPlay Receiver off (System Settings → General → AirDrop & Handoff)
   or change the hub port — edit $cfg_file and set hub.port to e.g. 5001,
   then unload + load the agent.
EOF
    else
        echo "[FAIL] LaunchAgent didn't register. Logs:" >&2
        echo "  stdout: $log_out" >&2
        echo "  stderr: $log_err" >&2
        [[ -f "$log_err" ]] && tail -50 "$log_err" >&2
        exit 1
    fi
}

#--- dispatch -----------------------------------------------------------------

case "$OS" in
    linux)  install_linux "$@" ;;
    macos)  install_macos "$@" ;;
esac
