# LuxSecurityCamera — Installation & Operation Manual

A step-by-step guide to set up the full system from scratch.

The system has three independent components:

- **Hub** (any Linux host with Node 18+, `meer.local` in the examples). The
  standalone server camera nodes connect to. Runs detection, recording,
  the dashboard. Lives in `hub/`.
- **Camera node** (`doorcam.local`, a Raspberry Pi Zero 2 W). Captures
  frames from a USB webcam and **publishes** them outbound to the hub.
  Runs no inbound listener. Lives in `camera_node/`. One per camera.
- **MagicMirror display** (*optional*, `meer.local`). A pure browser-side
  module that displays one camera's live feed on your MagicMirror. Lives
  in `mm_module/MMM-LuxSecurityDisplay/`.

---

## 0. The fast path — unified installer

On each device, clone the repo and run **one** installer at the root that
asks which component to set up:

```bash
git clone https://github.com/JaredLodwick/DoorCamera.git ~/LuxSecurityCamera
cd ~/LuxSecurityCamera
./install.sh
```

The installer:

1. Asks which component to install (1 = hub, 2 = camera, 3 = viewer).
2. For **camera**: prompts for the hub URL and a camera ID, writes
   `/etc/camera-node/config.yml`, then runs `camera_node/install.sh`.
3. For **viewer**: checks MagicMirror is installed (asks for the path),
   then runs `mm_module/install.sh` and prints the exact `config.js`
   snippet to paste in.
4. For **hub**: just runs `hub/install.sh`. Detection stays off until
   you opt in via the dashboard or the YAML config.
5. Cleans up unused components from the checkout. The rules:
   - **hub** install or **viewer** install → only `camera_node/` is
     removed. The `hub/` and `mm_module/` directories both stay so you
     can re-run `./install.sh` later and add the other one without
     re-cloning. (This is the typical setup for a MagicMirror Pi
     hosting both the hub service and the on-mirror display.)
   - **camera** install → both `hub/` and `mm_module/` are removed.
     A camera_node lives on dedicated hardware (a Pi Zero with a USB
     webcam); the other components have no business there.
6. Prints the dashboard URL and any next steps.

**Want both hub and viewer on the same MagicMirror Pi?** Just re-run
`./install.sh` on that Pi after the first install completes and pick
the other component. No re-cloning needed.

That's it for the typical install. The rest of this document is the
deep-dive — prerequisites, the manual steps each sub-installer takes
under the hood, troubleshooting, and migration notes.

---

## Prerequisites

This manual assumes both Pis are already:
- Flashed with Raspberry Pi OS Lite 64-bit (Bookworm or later)
- On your network and reachable over SSH (`pi@doorcam.local`, `pi@meer.local`)
- Have the repo cloned from GitHub (see Section 2 if not)

---

## 1. Before you start — prerequisites

Check each of these before moving on.

**Hardware plugged in:**
- USB webcam connected to the Pi via a data-capable USB OTG adapter.
- PiSugar power board attached (optional for MVP, but enables battery telemetry).

**Network:**
- Pi is on 2.4 GHz WiFi (the Zero 2 W does not support 5 GHz).
- You can SSH in: `ssh pi@doorcam.local` works from another machine on the same network.

**On the Pi:** quickly verify system basics before installing anything.

```bash
# Confirm you have internet
ping -c 2 github.com

# Confirm the clock is correct (fresh Pis sometimes have wrong time, which
# breaks SSL/git). If wrong, run: sudo timedatectl set-ntp true
date
```

## 2. Install system dependencies

These are the OS-level packages the camera software depends on.

```bash
sudo apt update
sudo apt install -y git python3-venv python3-pip v4l-utils avahi-daemon \
                    libopenblas0 libatlas3-base libgl1
```

What each of these does:
- `git` — fetch the repo.
- `python3-venv`, `python3-pip` — create isolated Python environments and install packages.
- `v4l-utils` — command-line tools for inspecting your USB webcam (`/dev/video*`).
- `avahi-daemon` — makes the Pi discoverable on the LAN as `doorcam.local` so you never have to chase its IP.
- `libopenblas0`, `libatlas3-base` — numerical libraries numpy's compiled extensions link against at runtime. Without `libopenblas0` you get `ImportError: libopenblas.so.0: cannot open shared object file` at startup.
- `libgl1` — OpenGL runtime that some ARM builds of OpenCV still pull in even on the headless wheel.

The same list is tracked in `camera_node/apt-requirements.txt` for future reference.

## 3. Verify the camera is detected

Plug the USB webcam in (if you haven't), then:

```bash
ls /dev/video*
# Expect at least /dev/video0

v4l2-ctl --list-devices
# Expect your webcam listed, e.g. "UVC Camera: /dev/video0"

v4l2-ctl --list-formats-ext -d /dev/video0
# Lists the resolutions and frame rates the camera can deliver.
```

If `/dev/video0` doesn't appear, the camera isn't being recognized. Common causes: USB cable is power-only (not a data cable), adapter is flaky, or the Pi's USB port is under-powered. Check `dmesg -w` while replugging to see kernel messages.

## 4. Install PiSugar power manager (optional but recommended)

Skip this if you're not using a PiSugar board. Without it, the `battery_pct` field in status will simply be `null` — nothing else breaks.

```bash
wget https://cdn.pisugar.com/release/pisugar-power-manager.sh
bash pisugar-power-manager.sh -c release
```

Follow the installer prompts. Once it finishes, test the daemon:

```bash
echo "get battery" | nc -q 0 127.0.0.1 8423
# Expect something like: battery: 87.5
```

## 5. Clone the repo (skip if already done)

```bash
cd ~
git clone git@github.com:JaredLodwick/DoorCamera.git LuxSecurityCamera
cd LuxSecurityCamera
```

Repo layout you'll see:

```
LuxSecurityCamera/
  PRD.md                                # product requirements
  INSTALLATION.md                       # this file
  README.md
  hub/                                  # standalone Node hub (HTTP+WS server, detection, dashboard)
  camera_node/                          # Python WebSocket publisher (this Pi)
  mm_module/MMM-LuxSecurityDisplay/     # optional MagicMirror display
```

## 6. Install the camera node

One command does everything — pip deps, `video` group membership, the systemd unit that runs on boot and auto-restarts on crash, and a default `/etc/camera-node/config.yml` if one isn't there yet.

```bash
cd ~/LuxSecurityCamera
./camera_node/install.sh
```

You'll be prompted for your sudo password once (the script self-elevates). It is **idempotent** — re-run it after a `git pull` to pick up upstream changes without resetting your config.

The installer auto-detects your username and the install path, so it works whether the repo is cloned in your home dir or under `/opt/`. When it finishes you should see:

```
[OK] camera-node.service is running.
```

### Configure

The installer drops a default config at `/etc/camera-node/config.yml` only if one doesn't already exist. The defaults — `640×480 @ 15 fps` on `/dev/video0`, hub at `ws://meer.local:5000`, cam id `front` — work out of the box if your MagicMirror Pi answers to `meer.local`. To change anything:

```bash
sudoedit /etc/camera-node/config.yml
sudo systemctl restart camera-node
```

### Verify the feed

Tail the publisher's logs as it connects:

```bash
journalctl -fu camera-node
```

You should see:

```
INFO camera_node.publisher: Connecting to hub at ws://meer.local:5000/cam/front
INFO camera_node.publisher: Hub requested state=on
```

`Hub requested state=off` instead means the hub thinks the camera should be off — check that the MagicMirror Pi is up to date with this repo and has been restarted. The hub defaults new cameras to `on` as soon as they connect.

If the webcam isn't plugged in, you'll see a warning about a mock camera. The publisher still runs; it just sends placeholder frames so you can sanity-check the wire side without hardware.

From any LAN device, the buffered MJPEG stream is at:

```
http://meer.local:5000/cam/front/stream.mjpg
```

The events dashboard is at:

```
http://meer.local:5000/
```

### Doing it manually instead

If `install.sh` doesn't fit (different init system, custom layout, no sudo, etc.), the underlying steps are:

```bash
cd ~/LuxSecurityCamera/camera_node
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
sudo usermod -aG video "$USER"          # for /dev/video0 access
sudo cp config.example.yml /etc/camera-node/config.yml
.venv/bin/python -m camera_node          # foreground test run; Ctrl+C to stop
```

To run it as a service without `install.sh`, write your own systemd unit modelled on what `install.sh` generates — only `User=`, `WorkingDirectory=`, and `ExecStart=` need templating.

---

## 7. Install the hub

Pick whichever box will be the hub. Anything with **Node.js 18+**:

- A spare Raspberry Pi 4 (8 GB) or Pi 5 (recommended for detection)
- The same Pi that runs MagicMirror (alongside MM as a separate service)
- A Linux desktop / NUC / mini-PC
- **A Mac** (Apple Silicon or Intel), installed as a launchd LaunchAgent
- **A Windows PC**, manual install — see [`hub/README.md`](hub/README.md#install--windows)

On Linux or macOS:

```bash
git clone git@github.com:JaredLodwick/DoorCamera.git ~/LuxSecurityCamera
cd ~/LuxSecurityCamera
./hub/install.sh
```

The installer detects the OS and takes the right path:

| Step | Linux (systemd) | macOS (launchd) |
|---|---|---|
| Pre-flight | Verifies Node 18+, npm, systemd. Warns on missing `ffmpeg`. | Verifies Node 18+, npm. Warns on missing `ffmpeg` (`brew install ffmpeg`). |
| Existing-hub probe | See [Re-installing / migrating the hub](#re-installing--migrating-the-hub) below. | Same. |
| Deps | `npm install --omit=dev` inside `hub/`. | Same. |
| Config | Bootstraps `/etc/lux-security-hub/config.yml` (sudo). | Bootstraps `~/.config/luxsecurityhub/config.yml` (no sudo). |
| Service | `/etc/systemd/system/lux-security-hub.service`, `systemctl enable + restart`. | `~/Library/LaunchAgents/com.luxsecurityhub.plist`, `launchctl load -w`. |
| Verify | `systemctl is-active --quiet`. | `launchctl list com.luxsecurityhub`. |

When it finishes you should see:

```
[OK] lux-security-hub.service is running.       # Linux
[OK] com.luxsecurityhub is running (pid …)      # macOS
```

The hub listens on **port 5000** (configurable). The dashboard is at `http://<hub-host>:5000/`. Camera nodes connect to `ws://<hub-host>:5000/cam/<cam_id>`.

> **macOS gotcha — port 5000.** macOS ships an AirPlay Receiver on port 5000. If the hub log shows `EADDRINUSE: address already in use 0.0.0.0:5000`, either disable AirPlay Receiver (System Settings → General → AirDrop & Handoff) or change `hub.port` in `~/.config/luxsecurityhub/config.yml` and reload the agent.

### Detection (optional, off by default)

Detection is disabled out of the box so a fresh install doesn't burn CPU before you opt in. Two ways to turn it on:

```bash
# Persistent (survives restart): edit the YAML
sudoedit /etc/lux-security-hub/config.yml             # Linux
${EDITOR:-vi} ~/.config/luxsecurityhub/config.yml     # macOS
# set detection.enabled: true, then restart:
sudo systemctl restart lux-security-hub               # Linux
launchctl unload ~/Library/LaunchAgents/com.luxsecurityhub.plist && \
  launchctl load -w ~/Library/LaunchAgents/com.luxsecurityhub.plist     # macOS

# Or runtime-only (cleared on next restart):
curl -X POST -H 'Content-Type: application/json' \
     -d '{"enabled":true}' http://localhost:5000/detection
```

The hub's dashboard at `http://<hub-host>:5000/` has a Detection toggle in the header that does the same thing.

If detection fails to start (e.g. `better-sqlite3` was built against a different Node version than the one the hub runs under) the dashboard surfaces the actual error — fix and re-run `./hub/install.sh`.

### Re-installing / migrating the hub

The hub installer is **idempotent and detection-aware**: before touching anything on disk, it probes the local machine for an existing hub and asks whether you have one running on another machine on your network.

**Re-installing on the same machine** is the right move for almost any hub problem you might have. The installer:

- Reads `hub.port` from your existing config and probes `http://localhost:<port>` for `/healthz` + `/cams`. If found, surfaces a "this looks like a re-install" message.
- Rewrites the systemd unit / LaunchAgent and restarts the service.
- **Preserves** `/etc/lux-security-hub/config.yml` / `~/.config/luxsecurityhub/config.yml` — your customizations survive.
- **Preserves** the events database and recorded clips.

If the hub is misbehaving, check logs first:

```bash
journalctl -fu lux-security-hub                       # Linux
tail -f ~/Library/Logs/LuxSecurityHub.err.log         # macOS
```

Then `git pull && ./hub/install.sh` should fix most config-related problems.

**Standing up a hub on a new machine** (because you're moving hardware, or recovering from a host that's truly dead) — the installer asks before letting you do this:

1. When asked "Do you already have a hub running on another machine on your network?" answer `y` and provide the URL.
2. The installer probes that URL. If it confirms the old hub is alive, it shows a structured menu for migrating, recovering, or running both — pick the relevant scenario.
3. After this hub finishes installing, **update each camera_node's config** to point at the new host:
   ```bash
   ssh user@camera-pi 'sudoedit /etc/camera-node/config.yml'
   # change `hub.url` to ws://<new-host>:5000, then:
   ssh user@camera-pi 'sudo systemctl restart camera-node'
   ```
4. **Update your MagicMirror module config** if you use one — change `hubUrl` in `~/MagicMirror/config/config.js`, restart MM, hard-refresh the browser.
5. **Stop the old hub** so it stops orphaning resources:
   ```bash
   ssh user@old-host 'sudo systemctl disable --now lux-security-hub'              # Linux
   ssh user@old-host 'launchctl unload ~/Library/LaunchAgents/com.luxsecurityhub.plist'   # macOS
   ```

To bypass all the pre-flight prompts (e.g. for a scripted install):

```bash
LUX_PREFLIGHT_DONE=1 ./hub/install.sh
```

---

## 8. (Optional) Install the MagicMirror display

Skip this whole section if you don't run MagicMirror. The system is fully usable via the dashboard at `http://<hub-host>:5000/`.

If you do run MagicMirror, on that Pi:

```bash
git clone git@github.com:JaredLodwick/DoorCamera.git ~/LuxSecurityCamera     # if not already cloned
cd ~/LuxSecurityCamera
./mm_module/install.sh
```

The installer just symlinks `<MagicMirror>/modules/MMM-LuxSecurityDisplay` into the repo. **No `npm install`** — the module is pure browser JS and talks to the hub over `fetch()`. (The script also cleans up the legacy `MMM-DoorCam` symlink from before the architecture split, if it finds one.)

Then add the module to `~/MagicMirror/config/config.js`:

```js
{
  module: "MMM-LuxSecurityDisplay",
  position: "bottom_right",
  config: {
    hubUrl: "http://meer.local:5000",   // wherever your hub is reachable
    camId: "front",                     // matches the camera_node config
    title: "Door Cam"
  }
}
```

Restart MagicMirror. The module starts polling the hub immediately. Hard-refresh the on-mirror browser (`Ctrl+Shift+R` in the Electron window) the first time so the new JS loads.

See [`mm_module/MMM-LuxSecurityDisplay/README.md`](mm_module/MMM-LuxSecurityDisplay/README.md) for the full config knob list.

---

# Operation

Once installed, day-to-day usage looks like this. All HTTP endpoints live on the **hub** (the MagicMirror Pi at `meer.local:5000`); the camera Pi has no inbound listener.

## Viewing the feed

Primary viewer: the `MMM-LuxSecurityDisplay` module on the MagicMirror itself.

For an ad-hoc view from any other device on your LAN:

```
http://meer.local:5000/cam/front/stream.mjpg
```

That's the multipart MJPEG stream of whatever frames the hub has buffered.

## Toggling the feed from the command line

Handy from SSH or scripts:

```bash
# Flip it
curl -X POST http://meer.local:5000/cam/front/toggle

# Set explicitly
curl -X POST -H "Content-Type: application/json" \
     -d '{"state":"on"}' \
     http://meer.local:5000/cam/front/toggle
```

The body is `{"state":"on"|"off"}` to set, no body to flip.

## Checking status

```bash
curl http://meer.local:5000/cam/front/status | python3 -m json.tool
```

Returns something like:

```json
{
  "cam_id": "front",
  "state": "on",
  "connected": true,
  "fresh": true,
  "fps": 15,
  "resolution": "640x480",
  "battery_pct": 87.5,
  "on_battery": false,
  "camera_available": true,
  "last_frame_age_ms": 64
}
```

`curl http://meer.local:5000/cams` lists every camera the hub knows about.

## Managing the service

```bash
sudo systemctl status camera-node      # current state, last few log lines
sudo systemctl restart camera-node     # pick up config changes
sudo systemctl stop camera-node
sudo systemctl start camera-node
sudo systemctl disable camera-node     # stop auto-starting on boot
sudo systemctl enable camera-node      # re-enable auto-start
```

## Viewing logs

The Pi client logs to the systemd journal.

```bash
# Live tail (Ctrl+C to exit)
journalctl -u camera-node -f

# Last 100 lines
journalctl -u camera-node -n 100

# Errors only, this boot
journalctl -u camera-node -p err -b
```

## Updating the code

Each component upgrades independently:

```bash
# On the camera Pi
cd ~/LuxSecurityCamera && git pull && ./camera_node/install.sh

# On the hub host
cd ~/LuxSecurityCamera && git pull && ./hub/install.sh

# On the MagicMirror Pi (optional)
cd ~/LuxSecurityCamera && git pull && ./mm_module/install.sh
# then restart MagicMirror + hard-refresh the on-mirror browser
```

All three installers are idempotent — they rewrite the systemd unit and restart the service, but leave existing config files (`/etc/camera-node/config.yml`, `/etc/lux-security-hub/config.yml`) alone so your customizations survive.

---

# Troubleshooting

### `doorcam.local` doesn't resolve

Your router or device's DNS setup isn't using mDNS. Three fallbacks:

1. Ensure avahi is running on the Pi: `sudo systemctl status avahi-daemon`.
2. Use the Pi's IP directly. On the Pi: `ip addr show wlan0` — find the `inet` line. Then browse to `http://<ip>:5000/`.
3. On Windows, install Bonjour Print Services to get mDNS support.

### "Camera not available" in the status tile

```bash
ls /dev/video*                    # is the device there?
v4l2-ctl --list-devices           # is the OS seeing the camera?
sudo systemctl restart camera-node    # pick up any hot-plug changes
journalctl -u camera-node -n 50       # look for camera open errors
```

If `/dev/video0` exists but the service can't open it, the camera-node user isn't in the `video` group: `sudo usermod -aG video $USER && sudo systemctl restart camera-node`.

### Stream is choppy or slow

The Pi Zero 2 W is CPU-limited. In `config.yml`, try:

```yaml
camera:
  resolution: [480, 360]
  fps: 10
  jpeg_quality: 60
```

Then `sudo systemctl restart camera-node`.

### Battery shows `—` in the UI

PiSugar daemon isn't reachable. Confirm:

```bash
sudo systemctl status pisugar-server
echo "get battery" | nc -q 0 127.0.0.1 8423
```

If the socket test fails, reinstall PiSugar (Section 4).

### Service won't start

```bash
sudo systemctl status camera-node
journalctl -u camera-node -n 100
```

Most common causes:
- Wrong paths in `/etc/systemd/system/camera-node.service` — verify `WorkingDirectory` and `ExecStart` point at real files.
- Missing Python packages — the venv the service points at doesn't have `requirements.txt` installed.
- `/dev/video0` permission denied — add user to the `video` group.

### Toggle button in the MagicMirror module does nothing

The browser-side module just `fetch()`es `POST /cam/<id>/toggle` on the hub. Things to check, in order:

1. `curl http://meer.local:5000/cams` from any LAN host. The camera should appear with `connected: true`. If it doesn't, the camera Pi can't reach the hub.
2. `curl -X POST http://meer.local:5000/cam/front/toggle` directly. If this works but the in-mirror button doesn't, force-refresh the MagicMirror page (`Ctrl+Shift+R` in the Electron window) — the browser may be running cached old module JS.
3. If `curl` to the hub also fails, the hub (`lux-security-hub.service`) isn't running on `meer.local`. `sudo systemctl status lux-security-hub`.

### Camera connects but feed stays off

You'll see this in the camera Pi's logs:

```
INFO camera_node.publisher: Connecting to hub at ws://meer.local:5000/cam/front
INFO camera_node.publisher: Hub requested state=off
```

The hub is telling the camera to stay off. New cameras default to `on` as soon as they connect, so seeing `state=off` means someone (UI or curl) explicitly toggled it off. Toggle it back:

```bash
curl -X POST -H 'Content-Type: application/json' \
     -d '{"state":"on"}' http://meer.local:5000/cam/front/toggle
```

---

# Migrating from the embedded hub

If you set up an earlier version where the hub server lived inside MagicMirror's `MMM-DoorCam` module, the migration to the standalone hub is mechanical:

```bash
ssh meer.local

# 1. Stop the old in-MM hub by removing the legacy module from MagicMirror
#    (or just leave the line commented out — the new ./mm_module/install.sh
#    cleans up the old MMM-DoorCam symlink).

# 2. Pull the new code and install the standalone hub:
cd ~/LuxSecurityCamera   # or wherever you have it
git pull
./hub/install.sh         # creates lux-security-hub.service, listens on :5000

# 3. (Optional) install the new MagicMirror display module:
./mm_module/install.sh
#    then update ~/MagicMirror/config/config.js: rename module to
#    "MMM-LuxSecurityDisplay" and add `hubUrl: "http://meer.local:5000"`.
#    Drop the old detection/recording/clipsRoot/dbPath keys — those now
#    live in /etc/lux-security-hub/config.yml on the hub.

# 4. On the camera Pi, replace the old service with the new one:
ssh pi@doorcam.local
cd ~/LuxSecurityCamera
sudo systemctl disable --now doorcam   # was the old unit name
./camera_node/install.sh                # registers camera-node.service
```

The wire protocol between camera and hub is unchanged — `ws://meer.local:5000/cam/<cam_id>` still works exactly the same. Only paths and identifiers moved.

Existing data: clips at `~/Videos/SecurityCamera/` keep working (path unchanged). The events DB moved from `~/.mm-doorcam/events.db` to `~/.luxsecurityhub/events.db` — if you want your historical events back, `mv ~/.mm-doorcam/events.db ~/.luxsecurityhub/events.db` on the hub host before the first start.

---

# Security notes

This MVP is designed for a **trusted home LAN** only. Things to be aware of before expanding use:

- The HTTP server has no TLS (encryption) and no authentication. Anyone on your WiFi can view or toggle the feed.
- Do **not** port-forward port 5000 on your router to expose it to the internet. Use a VPN (WireGuard, Tailscale) if you need remote access.
- The Pi's SSH login password is the primary protection for the device itself. Change it from the default with `passwd` on the Pi — a short password like `knockknock` is fine against casual curiosity but not against determined attackers who get onto your network.
- Future project phases will introduce a central server, authenticated clients, and possibly public-key-only SSH. See `PRD.md` Section 10 for the roadmap.

---

# Quick reference card

| What you want | Command / URL |
|---|---|
| SSH into the camera Pi | `ssh pi@doorcam.local` |
| Primary viewer | `MMM-LuxSecurityDisplay` module on the MagicMirror itself |
| Ad-hoc viewer | `http://meer.local:5000/cam/front/stream.mjpg` in any browser |
| Toggle via CLI | `curl -X POST http://meer.local:5000/cam/front/toggle` |
| Status JSON | `curl http://meer.local:5000/cam/front/status` |
| List all cams | `curl http://meer.local:5000/cams` |
| Hub health | `curl http://meer.local:5000/healthz` |
| Camera service state | `sudo systemctl status camera-node` |
| Camera live logs | `journalctl -u camera-node -f` |
| Restart camera service | `sudo systemctl restart camera-node` |
| Pull latest code (camera) | `cd ~/LuxSecurityCamera && git pull && ./camera_node/install.sh` |
| Edit config | `sudoedit /etc/camera-node/config.yml` (then `sudo systemctl restart camera-node`) |
| Test camera detected | `v4l2-ctl --list-devices` |
| Test PiSugar socket | `echo "get battery" \| nc -q 0 127.0.0.1 8423` |

---

*See `PRD.md` for the full project spec, architecture, and future roadmap.*
