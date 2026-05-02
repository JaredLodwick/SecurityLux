# Door Cam — Installation & Operation Manual

A step-by-step guide to get the Door Cam software running and streaming to your MagicMirror.

The system has two pieces:

- **Camera Pi** (`doorcam.local`, a Raspberry Pi Zero 2 W) — captures frames from a USB webcam and **publishes** them outbound to the hub. Runs no inbound listener. This manual focuses here.
- **MagicMirror Pi** (`meer.local`) — runs MagicMirror² with the `MMM-DoorCam` module, which doubles as the camera **hub**: a single HTTP+WebSocket server on port 5000 that cameras connect into and that the on-mirror UI (and other LAN consumers) read from.

This manual assumes the camera Pi is already:
- Flashed with Raspberry Pi OS Lite 64-bit (Bookworm or later)
- On your WiFi network
- Reachable over SSH at `pi@doorcam.local`
- Has the repo cloned from GitHub (see Section 2 if not)

It also assumes the MagicMirror Pi is already up and running MagicMirror². See `mm_module/MMM-DoorCam/README.md` for the hub-side install (a one-line `./mm_module/install.sh` symlink + a `config.js` entry).

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

The same list is tracked in `pi_client/apt-requirements.txt` for future reference.

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

## 5. Clone the Door Cam repo (skip if already done)

```bash
cd ~
git clone git@github.com:JaredLodwick/DoorCamera.git
cd DoorCamera
```

Repo layout you'll see:

```
DoorCamera/
  PRD.md                   # product requirements
  INSTALLATION.md          # this file
  README.md
  pi_client/               # Python WS publisher (this Pi)
  mm_module/MMM-DoorCam/   # MagicMirror module + hub server (the other Pi)
```

## 6. Install the Pi client

The Pi client is a Python application. It lives inside its own virtual environment so it doesn't clash with system Python packages.

```bash
cd ~/DoorCamera/pi_client

# Create an isolated Python environment in .venv
python3 -m venv .venv

# Activate it — your shell prompt should now show (.venv)
source .venv/bin/activate

# Upgrade pip inside the venv
pip install --upgrade pip

# Install all dependencies listed in requirements.txt
pip install -r requirements.txt
```

This will take a few minutes on a Pi Zero 2 W — OpenCV's wheel is large. Be patient.

### Configure

Copy the example config and review the defaults:

```bash
cp config.example.yml config.yml
nano config.yml          # or use vim / your editor of choice
```

The defaults (640×480 @ 15 fps on `/dev/video0`, hub at `ws://meer.local:5000`) are intentionally conservative for the Pi Zero 2 W's 512 MB of RAM. You can bump resolution or fps later once you confirm things work; I'd advise starting with the defaults.

If your MagicMirror Pi has a different hostname, change `hub.url` to point at it.

## 7. Test run (foreground)

With the venv still active:

```bash
python -m doorcam
```

You should see log output similar to:

```
INFO doorcam.config: Loading config from ./config.yml
INFO doorcam.publisher: Connecting to hub at ws://meer.local:5000/cam/front
INFO doorcam.publisher: Hub requested state=on
```

If you instead see `Hub requested state=off`, the hub thinks the camera should be off — check that the MagicMirror Pi is up to date with this repo and that MagicMirror has been restarted. The hub defaults new cameras to `on` as soon as they connect.

If the webcam isn't plugged in or fails to open, you'll see a warning about a mock camera. The publisher still runs; it just sends placeholder frames. Good for sanity-checking the wire side without hardware.

### View the feed

The feed renders in the `MMM-DoorCam` module on the MagicMirror itself. From any other device on your LAN you can also fetch the buffered MJPEG stream directly from the hub:

```
http://meer.local:5000/cam/front/stream.mjpg
```

Open that URL in a browser and you should see the live frames the camera Pi is publishing.

### Stop the test run

Press `Ctrl+C` in the SSH terminal to stop.

## 8. Install as a system service (auto-start on boot)

You don't want to SSH in and launch the process every reboot. `systemd` handles this.

The shipped service file expects the code at `/opt/doorcam`. Two common paths:

### Option A — install to `/opt/doorcam` (matches the shipped service file)

```bash
# Create the destination and copy the code
sudo mkdir -p /opt/doorcam
sudo cp -r ~/DoorCamera/pi_client /opt/doorcam/

# Let the 'pi' user own it so the service can write logs etc.
sudo chown -R pi:pi /opt/doorcam

# Create a fresh venv in the new location
cd /opt/doorcam/pi_client
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
cp config.example.yml config.yml
deactivate

# Install the systemd unit
sudo cp /opt/doorcam/pi_client/deploy/doorcam.service /etc/systemd/system/

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable doorcam
sudo systemctl start doorcam

# Confirm it's running
sudo systemctl status doorcam
```

### Option B — keep the repo in your home dir and edit the service file

```bash
sudo cp ~/DoorCamera/pi_client/deploy/doorcam.service /etc/systemd/system/
sudo nano /etc/systemd/system/doorcam.service
```

Change these two lines so they point at your repo clone:

```ini
WorkingDirectory=/home/pi/DoorCamera/pi_client
ExecStart=/home/pi/DoorCamera/pi_client/.venv/bin/python -m doorcam
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable doorcam
sudo systemctl start doorcam
sudo systemctl status doorcam
```

Both paths produce the same result. Option A is the "official" one — consider it the production install — and Option B is convenient during active development when you want `git pull` to update the running code.

### Camera device permissions

The service runs as user `pi`. For the service to read from `/dev/video0`, `pi` must be in the `video` group. Most Raspberry Pi OS installs have this by default, but if the service logs permission errors opening the camera:

```bash
sudo usermod -aG video pi
sudo systemctl restart doorcam
```

---

# Operation

Once installed, day-to-day usage looks like this. All HTTP endpoints live on the **hub** (the MagicMirror Pi at `meer.local:5000`); the camera Pi has no inbound listener.

## Viewing the feed

Primary viewer: the `MMM-DoorCam` module on the MagicMirror itself.

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
sudo systemctl status doorcam      # current state, last few log lines
sudo systemctl restart doorcam     # pick up config changes
sudo systemctl stop doorcam
sudo systemctl start doorcam
sudo systemctl disable doorcam     # stop auto-starting on boot
sudo systemctl enable doorcam      # re-enable auto-start
```

## Viewing logs

The Pi client logs to the systemd journal.

```bash
# Live tail (Ctrl+C to exit)
journalctl -u doorcam -f

# Last 100 lines
journalctl -u doorcam -n 100

# Errors only, this boot
journalctl -u doorcam -p err -b
```

## Updating the code

```bash
# If you installed via Option A (/opt/doorcam)
cd /opt/doorcam/pi_client
sudo git -C /opt/doorcam pull     # only if /opt/doorcam is a git clone; otherwise re-copy from ~/DoorCamera
sudo systemctl restart doorcam

# If you installed via Option B (home dir)
cd ~/DoorCamera
git pull
sudo systemctl restart doorcam
```

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
sudo systemctl restart doorcam    # pick up any hot-plug changes
journalctl -u doorcam -n 50       # look for camera open errors
```

If `/dev/video0` exists but the service can't open it, check group membership (see "Camera device permissions" in Section 8).

### Stream is choppy or slow

The Pi Zero 2 W is CPU-limited. In `config.yml`, try:

```yaml
camera:
  resolution: [480, 360]
  fps: 10
  jpeg_quality: 60
```

Then `sudo systemctl restart doorcam`.

### Battery shows `—` in the UI

PiSugar daemon isn't reachable. Confirm:

```bash
sudo systemctl status pisugar-server
echo "get battery" | nc -q 0 127.0.0.1 8423
```

If the socket test fails, reinstall PiSugar (Section 4).

### Service won't start

```bash
sudo systemctl status doorcam
journalctl -u doorcam -n 100
```

Most common causes:
- Wrong paths in `/etc/systemd/system/doorcam.service` — verify `WorkingDirectory` and `ExecStart` point at real files.
- Missing Python packages — the venv the service points at doesn't have `requirements.txt` installed.
- `/dev/video0` permission denied — add user to the `video` group.

### Toggle button in the MagicMirror module does nothing

The browser-side module sends a socket notification to the hub's `node_helper`, which calls `setDesiredState` and forwards `set_state` down the WebSocket to the camera. Things to check, in order:

1. `curl http://meer.local:5000/cams` from any LAN host. The camera should appear with `connected: true`. If it doesn't, the camera Pi can't reach the hub.
2. `curl -X POST http://meer.local:5000/cam/front/toggle` directly. If this works but the in-mirror button doesn't, force-refresh the MagicMirror page (`Ctrl+Shift+R` in the Electron window) — the browser may be running cached old module JS.
3. If `curl` to the hub also fails, the MagicMirror process or the `MMM-DoorCam` module isn't running on `meer.local`.

### Camera connects but feed stays off

You'll see this in the camera Pi's logs:

```
INFO doorcam.publisher: Connecting to hub at ws://meer.local:5000/cam/front
INFO doorcam.publisher: Hub requested state=off
```

The hub is telling the camera to stay off. New cameras default to `on` as soon as they connect, so seeing `state=off` means either:
- The MagicMirror Pi is running an older version of `MMM-DoorCam` — `git pull` and restart MagicMirror.
- Someone (UI or curl) explicitly toggled it off. Toggle it back: `curl -X POST -H 'Content-Type: application/json' -d '{"state":"on"}' http://meer.local:5000/cam/front/toggle`.

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
| Primary viewer | `MMM-DoorCam` module on the MagicMirror itself |
| Ad-hoc viewer | `http://meer.local:5000/cam/front/stream.mjpg` in any browser |
| Toggle via CLI | `curl -X POST http://meer.local:5000/cam/front/toggle` |
| Status JSON | `curl http://meer.local:5000/cam/front/status` |
| List all cams | `curl http://meer.local:5000/cams` |
| Hub health | `curl http://meer.local:5000/healthz` |
| Camera service state | `sudo systemctl status doorcam` |
| Camera live logs | `journalctl -u doorcam -f` |
| Restart camera service | `sudo systemctl restart doorcam` |
| Pull latest code (camera) | `cd ~/DoorCamera && git pull && sudo systemctl restart doorcam` |
| Edit config | `sudo nano /opt/doorcam/pi_client/config.yml` (or wherever you installed) |
| Test camera detected | `v4l2-ctl --list-devices` |
| Test PiSugar socket | `echo "get battery" \| nc -q 0 127.0.0.1 8423` |

---

*See `PRD.md` for the full project spec, architecture, and future roadmap.*
