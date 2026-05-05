# LuxSecurityHub

Standalone hub for the LuxSecurity camera system. Runs as a regular Node.js
service — no MagicMirror required. Camera nodes connect to it over WebSocket
and push JPEG frames; the hub buffers the latest frame per camera, runs
optional on-host person detection, records per-event video clips, and
exposes the whole thing via HTTP for browsers / scripts / other consumers.

## What runs where

```
camera_node (Pi Zero, /dev/video0)  →  WebSocket  →  Hub  →  HTTP / MJPEG / dashboard / clips
```

The hub is just one Node.js process. It can run on:

- A spare Raspberry Pi (4 8 GB recommended for detection).
- The same Pi that runs MagicMirror (alongside MM, as a separate systemd unit).
- A desktop / NUC / x86 Linux box on the same LAN.
- A **Mac** (macOS, Apple Silicon or Intel) — installed as a launchd LaunchAgent.
- A **Windows** PC — manual install (see below).

## Install — Linux & macOS

The same installer covers both. Clone and run:

```bash
git clone https://github.com/JaredLodwick/DoorCamera.git ~/LuxSecurityCamera
cd ~/LuxSecurityCamera
./hub/install.sh
```

It detects your OS and dispatches:

**Linux (systemd):**

1. Verifies Node.js >= 18, npm, and systemd. Warns if `ffmpeg` is missing
   (detection still works, recording silently skips without it).
2. `npm install --omit=dev` inside `hub/` (pulls `onnxruntime-node`,
   `sharp`, `better-sqlite3`, `ws`, `js-yaml`).
3. Bootstraps `/etc/lux-security-hub/config.yml` from `config.example.yml`
   (only if absent — re-runs preserve customization).
4. Generates `/etc/systemd/system/lux-security-hub.service` with your
   user + install path templated in. `Restart=on-failure`, comes back on
   reboot.
5. Enables, starts, and verifies. Prints a summary of useful commands.

**macOS (launchd LaunchAgent):**

1. Same Node + npm sanity checks. Warns if `ffmpeg` is missing
   (`brew install ffmpeg`).
2. `npm install --omit=dev` inside `hub/`.
3. Bootstraps `~/.config/luxsecurityhub/config.yml` from `config.example.yml`.
   No sudo needed for any of this — everything is per-user.
4. Writes `~/Library/LaunchAgents/com.luxsecurityhub.plist` with `RunAtLoad`
   and `KeepAlive` on Crashed.
5. `launchctl load -w` it; verifies; prints useful commands.

> **macOS gotcha — port 5000.** Modern macOS runs an AirPlay Receiver on
> port 5000 by default. If the hub log shows
> `EADDRINUSE: address already in use 0.0.0.0:5000`, either:
> - Disable AirPlay Receiver: System Settings → General → AirDrop & Handoff
> - Or change the hub port: edit `~/.config/luxsecurityhub/config.yml`
>   and set `hub.port: 5001` (or anything free), then
>   `launchctl unload ~/Library/LaunchAgents/com.luxsecurityhub.plist`
>   and `launchctl load -w …` to restart.

The macOS install runs the hub as a **LaunchAgent** (per-user). It comes
back when you log in. Most Macs auto-login the user on boot, so the hub
is back after a restart. For "boot before login" behavior, install as a
LaunchDaemon under `/Library/LaunchDaemons/` instead — that requires
sudo + manual plist work; the installer doesn't do it for you.

The Linux + macOS installer is **idempotent** — re-run after `git pull`
to upgrade.

### Pre-flight: existing-hub detection

Before touching anything on disk, the installer:

1. Reads `hub.port` from any existing config and probes
   `http://localhost:<port>` for `/healthz` + `/cams`. If a hub is already
   running on this machine, it surfaces a "this looks like a re-install"
   message — defaults to **Yes, continue** (safe; config and events DB
   are preserved).
2. Asks whether you already have a hub running on **another** machine on
   your network. If you say yes, it probes that URL and shows a
   structured guidance menu for migrating, recovering, or running both
   — defaults to **No** (the most common right answer is "fix the
   existing one, don't stand up a second"). The installer is idempotent
   on the original host, and most "broken hub" problems are
   config-related, not install-corruption.

To bypass the prompts (e.g. for a scripted install):

```bash
LUX_PREFLIGHT_DONE=1 ./hub/install.sh
```

## Install — Windows

There's no auto-installer for Windows yet. Clone, install deps, and run
manually — or wrap it in a Windows Service yourself.

```powershell
# In an admin PowerShell (or a regular one if Node is on PATH):
git clone https://github.com/JaredLodwick/DoorCamera.git C:\LuxSecurityCamera
cd C:\LuxSecurityCamera\hub
npm install --omit=dev

# Optional: install ffmpeg via Chocolatey or Scoop for clip recording
#   choco install ffmpeg
#   scoop install ffmpeg

# Foreground (for testing):
node src\hub.js
```

Open `http://localhost:5000/` to see the dashboard.

To run it as a background service that survives reboots, the easiest
approach is [NSSM](https://nssm.cc/) ("the non-sucking service manager"):

```powershell
# After downloading NSSM and putting nssm.exe on your PATH:
nssm install LuxSecurityHub "C:\Program Files\nodejs\node.exe" "C:\LuxSecurityCamera\hub\src\hub.js"
nssm set    LuxSecurityHub AppDirectory "C:\LuxSecurityCamera\hub"
nssm set    LuxSecurityHub AppEnvironmentExtra "LUXHUB_CONFIG=%USERPROFILE%\.config\luxsecurityhub\config.yml"
nssm set    LuxSecurityHub AppStdout "%USERPROFILE%\AppData\Local\LuxSecurityHub\stdout.log"
nssm set    LuxSecurityHub AppStderr "%USERPROFILE%\AppData\Local\LuxSecurityHub\stderr.log"
nssm start  LuxSecurityHub

# Bootstrap the config dir if it doesn't exist yet:
mkdir "$env:USERPROFILE\.config\luxsecurityhub"
copy config.example.yml "$env:USERPROFILE\.config\luxsecurityhub\config.yml"
```

Manage with `nssm restart LuxSecurityHub`, `nssm stop LuxSecurityHub`, etc.

A first-class `install.ps1` is on the roadmap; PRs welcome.

## Run without a service manager (dev / testing, any OS)

```bash
cd hub
npm install
node src/hub.js                                   # uses ~/.config/luxsecurityhub/config.yml or built-in defaults
LUXHUB_CONFIG=/tmp/luxhub.yml node src/hub.js     # or point at any YAML
node src/hub.js /path/to/config.yml               # or pass it as a CLI arg
```

The hub binds to `0.0.0.0:5000` by default. Open `http://<host>:5000/`
for the events dashboard. Config search order:

1. CLI arg (`node src/hub.js /path/to/config.yml`)
2. `$LUXHUB_CONFIG` env var
3. `~/.config/luxsecurityhub/config.yml` (user-level; cross-OS)
4. `/etc/lux-security-hub/config.yml` (system-level; Linux/systemd)
5. Built-in defaults (with a `config file not found` warning)

## HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/`                                | The events dashboard (single self-contained HTML page). |
| `GET`  | `/healthz`                         | Plain `ok`. |
| `GET`  | `/cams`                            | JSON list of registered cameras + last-known status. |
| `GET`  | `/cam/<id>/status`                 | Status for one camera (state, connected, fps, battery, current_detection, …). |
| `GET`  | `/cam/<id>/stream.mjpg`            | Multipart MJPEG stream of the buffered frames. |
| `POST` | `/cam/<id>/toggle`                 | Body `{"state":"on"\|"off"}` to set; no body to flip. |
| `POST` | `/cam/<id>/detection`              | Body `{"enabled": bool}` — per-camera detection mute. The hub-wide `/detection` endpoint controls whether the detector worker runs at all; this finer-grained gate just hides one camera's frames from inference. |
| `GET`  | `/cam/<id>/events?since=&limit=`   | Detection events list (paginated, newest first). |
| `GET`  | `/events/<id>`                     | Single event JSON. |
| `GET`  | `/events/<id>/clip.<ext>`          | Streams the recorded clip with `Range` support. |
| `GET`  | `/detection`                       | `{ enabled, available, error }`. |
| `POST` | `/detection`                       | Body `{"enabled": bool}` to start/stop the detector at runtime. |

CORS is wide-open — designed for a trusted LAN. Do **not** expose port 5000
to the public internet without sticking auth + TLS in front of it.

## WebSocket (camera ↔ hub)

`ws://<hub>:5000/cam/<cam_id>` — one connection per camera node.

- **camera → hub (binary):** a JPEG frame. Last-writer-wins.
- **camera → hub (text JSON):** `{"type":"hello", "cam_id", "capabilities":{...}}` once on connect, then `{"type":"status", ...}` every ~5 s.
- **hub → camera (text JSON):** `{"type":"set_state","state":"on"|"off"}` and `{"type":"hello_ack","cam_id":"..."}`.

## Tests

```bash
cd hub
npm install
npm test            # equivalent to: node --test tests/*.test.js
```

12 tests covering the SQLite store and the session state machine. The
detector + recorder are I/O-bound and verified end-to-end on the hub.

## Configuration

See `config.example.yml`. Every key has a built-in default — partial files
are fine. To toggle detection at runtime without restarting:

```bash
curl -X POST -H 'Content-Type: application/json' \
     -d '{"enabled":true}' http://localhost:5000/detection
```

## See also

- `../camera_node/` — the Pi Zero publisher
- `../mm_module/MMM-LuxSecurityDisplay/` — optional MagicMirror display
- `../PRD.md` — full product / architecture doc
