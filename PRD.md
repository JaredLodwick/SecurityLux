# Door Cam — Product Requirements Document

**Project:** Door Cam (custom Raspberry Pi security camera with MagicMirror integration)
**Owner:** Jared
**Status:** v2 architecture — MagicMirror Pi is the hub; cameras publish to it
**Last updated:** 2026-04-26
**Document version:** 0.2 (living document)

> **Architecture note (v0.2):** the original v0.1 design had each camera Pi running its own Flask server that the Mirror polled. v0.2 inverts that: the always-on MagicMirror Pi (`meer.local`) hosts the hub, and cameras connect *out* to it over a single WebSocket. This document reflects v0.2 throughout.

---

## 1. Overview

Door Cam is a custom, low-cost security camera built on a Raspberry Pi Zero 2 W. The camera sits at the front door, captures live video, and pushes it to the MagicMirror² Pi (`meer.local`) which acts as the home's always-on **smart-device hub**. The hub buffers the latest frame and exposes it to:

1. The MagicMirror² display itself, via the `MMM-DoorCam` browser module.
2. Any other LAN client (`curl`, scripts, future detector workers) that talks to the hub's HTTP endpoints.

The system is single-camera today but the protocol is keyed by a `cam_id` so additional cameras (and other smart devices the hub could host) drop in without protocol changes. The hub is also where future on-device intelligence — object recognition, event logging, home-automation — will live, because the Mirror Pi is plugged into mains power and runs 24/7.

## 2. Goals & Non-goals

### Goals
- Reliably capture video from a USB webcam attached to a Pi Zero 2 W at the front door.
- Push the feed to the MagicMirror hub with acceptable latency (target: under 2 seconds glass-to-glass).
- Centralize control and viewing on the MagicMirror Pi so one always-on device is the single hub for current and future smart devices.
- Keep the camera unit lightweight — no on-device recognition, minimal CPU/RAM load, minimal dependencies — so it runs comfortably on 512 MB of RAM and on battery when needed.
- Survive short power outages using the PiSugar backup battery and resume streaming automatically when power is restored.
- Provide clear, reproducible setup instructions so a fresh camera Pi can be provisioned end-to-end.

### Non-goals (current scope)
- No cloud streaming or remote (off-LAN) access.
- No recording, clip storage, or event timelines (yet — see Roadmap).
- No face/object recognition on the camera itself; that's hub work (see Roadmap).
- No user accounts, authentication, or role-based access — assumes trusted home LAN.
- No encryption of the LAN traffic — will revisit when the system grows beyond the home network.

## 3. Hardware

| Component | Notes |
|---|---|
| Raspberry Pi Zero 2 W | Quad-core ARM Cortex-A53 @ 1 GHz, **512 MB RAM**. This is the only configuration sold — plan all software within this constraint. |
| Camera | Generic USB webcam (UVC-compliant). Powered from the Pi's USB port via a USB-OTG adapter cable. |
| Power | PiSugar 2 / PiSugar 3 power board with LiPo backup battery. Powers the Pi during mains cutoffs and allows graceful behavior on power return. |
| Enclosure | 3D Printed — mounted at front door, weather-protected. |
| Viewing Pi | Separate Raspberry Pi on the same LAN running MagicMirror². Hardware model not constrained by this project. |
| Network | Home WiFi (2.4 GHz, the Zero 2 W does not support 5 GHz). |

### 512 MB RAM implications (why this shapes the stack)
The Zero 2 W is not a powerhouse. A single Python process, a couple of camera buffers, and the OS comfortably fit in 512 MB, but we must avoid:
- Loading OpenCV face recognition models on-device.
- Running multiple concurrent encoders.
- Using heavyweight frameworks (no Django, no Electron-style viewers).
- High-res + high-FPS combos (we'll default to 640×480 @ 15 fps for MVP).

## 4. System architecture

```
+--------------------------+                       +-------------------------+
|  Door Cam (Pi Zero 2W)   |                       |  MagicMirror Pi (hub)   |
|                          |                       |  hostname: meer.local   |
|  USB webcam              |                       |                         |
|    |                     |   single outbound     |  MMM-DoorCam            |
|    v                     |   WebSocket           |   - node_helper.js      |
|  CameraManager (capture) |                       |     HTTP+WS on :5000    |
|    |                     |   binary JPEG frames  |     buffers latest      |
|    v                     |======================>|     frame per cam       |
|  Publisher (asyncio WS)  |   text JSON status    |   - browser module      |
|    |                     |<======================|     <img src=stream>    |
|  PiSugar (battery)       |   text JSON commands  |     toggle button       |
+--------------------------+   (set_state on/off)  |                         |
                                                   |  Other LAN consumers    |
                                                   |  (curl, future detector |
                                                   |   workers, recorders)   |
                                                   |   <- HTTP /cam/<id>/... |
                                                   +-------------------------+
```

**Hub-and-spoke architecture.** The MagicMirror Pi is the always-on hub for the household's smart devices. The hub owns:

- the desired on/off state for each camera,
- the latest-frame buffer (last-writer-wins, no per-client queueing),
- the HTTP surface that browsers, scripts, and future workers consume.

The camera Pi runs only what it must: capture, encode, and a thin async WebSocket publisher. When the hub commands `state: off` the camera releases the V4L2 device, dropping draw to near-idle — important because the camera may run on PiSugar battery for short windows.

### Why WebSocket between camera and hub, MJPEG to browsers?

Each link picked for what it's good at:

- **Camera → hub: WebSocket.** One persistent outbound TCP connection. The camera never opens a listening port; it sends binary JPEG frames upstream and receives JSON control messages downstream over the same socket. Cheaper than re-handshaking HTTP per status update or polling a server, and the bidirectional channel naturally carries hub→camera commands. Reconnects with exponential backoff on network blips.
- **Hub → browser: MJPEG over HTTP.** A plain `<img src="…/stream.mjpg">` natively renders a `multipart/x-mixed-replace` response with zero JavaScript. The hub re-fans the buffered frames out to any number of HTTP viewers without re-encoding. Higher bandwidth than modern codecs, but acceptable on a wired LAN and trivial to debug.
- **WebRTC** is still the lowest-latency option but its complexity (STUN/TURN, SDP) isn't justified for a LAN-only setup.

The camera only ever talks to one place (the hub), so security review is simple. Adding a second camera is a config change, not a network change.

## 5. Feature list

| # | Feature | Description |
|---|---|---|
| F1 | USB camera capture | Read frames from `/dev/video0` via V4L2 (OpenCV wrapper). |
| F2 | WebSocket publisher | The camera connects out to `ws://meer.local:5000/cam/<cam_id>` and pushes binary JPEGs while the feed is on. Reconnects with exponential backoff on network blips. |
| F3 | Hub frame buffer + MJPEG re-fan | The MagicMirror node_helper buffers the latest frame per camera and re-serves it as `GET /cam/<id>/stream.mjpg` (multipart MJPEG) to any number of HTTP viewers. |
| F4 | Manual on/off toggle | `POST /cam/<id>/toggle` (or the MM module's button) updates the hub's desired state and forwards `{type:"set_state",state:...}` down the WebSocket. The camera releases the V4L2 device when `off`. |
| F5 | Status endpoint | `GET /cam/<id>/status` returns JSON with `{state, connected, fps, resolution, battery_pct, on_battery, camera_available, …}` from the hub's last-known view. |
| F6 | PiSugar battery reporting | Camera reads battery % + charging from the PiSugar daemon and includes both in periodic status messages it pushes to the hub. |
| F7 | MagicMirror² module | `MMM-DoorCam` is dual-role: a browser UI (renders the MJPEG, exposes the toggle) plus the `node_helper.js` that actually IS the hub server. |
| F8 | Auto-start on boot | Camera publisher runs as a `systemd` unit and comes up on boot / after power loss. The hub starts with MagicMirror itself. |
| F9 | mDNS / .local hostnames | Camera resolves the hub at `meer.local`; the camera Pi continues to be reachable at `doorcam.local` for SSH/admin. |
| F10 | `cam_id` keyed protocol | Every WS connection and HTTP route is namespaced by `cam_id`. Adding a second camera is a config change on the new Pi (`camera.id: porch`) and a second `MMM-DoorCam` entry on the mirror. |

## 6. Non-functional requirements

- **Latency:** under 2 seconds glass-to-glass on LAN at 640×480 @ 15 fps.
- **CPU/RAM budget on Pi Zero 2 W:** camera process stays under ~40% CPU average and ~150 MB RAM. With the feed `off` the publisher only keeps the WS open and idles — well under 1% CPU.
- **Startup time:** camera registered with hub within 90 seconds of powering on.
- **Resilience:**
    - publisher: `systemd Restart=on-failure` plus in-process WS reconnect with exponential backoff (1s → 30s).
    - hub: starts with MagicMirror; survives camera disconnects (state preserved, frame buffer cleared, browser sees an "offline" placeholder until the camera reconnects).
- **Configurability:** single YAML config file (`/etc/doorcam/config.yml` on the camera) for `hub.url`, `camera.id`, resolution, fps. The hub's bind port and per-camera display options live in MagicMirror's `config.js`.

## 7. Tech stack

### Camera unit (Pi Zero 2 W)
- **OS:** Raspberry Pi OS Lite (64-bit), Bookworm or later — headless, no desktop.
- **Language:** Python 3.11+ (`asyncio`).
- **Networking:** `websockets` (Python WS client). The publisher is a single async loop; no Flask, no inbound ports.
- **Camera I/O:** OpenCV (`cv2.VideoCapture`) for USB UVC cameras. Fallback: raw V4L2 via `v4l2-ctl` if OpenCV proves too heavy.
- **Process manager:** `systemd` — restarts the publisher on crash; the publisher itself handles transient hub disconnects internally.
- **Battery integration:** PiSugar daemon (`pisugar-server`) over its local socket API.
- **Discovery:** `avahi-daemon` for `.local` mDNS — used to resolve the hub at `meer.local`.

### Hub (MagicMirror Pi)
- **Lives inside MagicMirror.** The hub server is the `node_helper.js` of `MMM-DoorCam`, so it starts and stops with MagicMirror itself — no extra process to manage.
- **Language:** Node.js (whatever MagicMirror is using).
- **Networking:** the standard `http` module + the `ws` package (already in MagicMirror's `node_modules`). Binds its own port (default `5000`) so camera traffic is independent of MagicMirror's `ipWhitelist`.
- **Browser UI:** the same module's `MMM-DoorCam.js` renders the toggle button, status bar, and the `<img>` pointed at the hub's MJPEG endpoint. Status updates are pushed to the browser via MagicMirror's `socketNotification` channel — no client-side polling.

### Why split Python on the camera and Node on the hub?
Python's Pi ecosystem (OpenCV, picamera2, later `face_recognition`, `dlib`) is what makes camera-side work easy. Node is mandatory on the hub because that's MagicMirror's runtime — and it gives us `ws` and the `http` server for free. The interface between them is a tiny WebSocket protocol (binary frames + a handful of JSON message types).

## 8. API / Interfaces

All consumer-facing endpoints live on the **hub** (MagicMirror Pi at `meer.local`, port 5000). Cameras connect into the hub over WebSocket; they expose nothing themselves.

### 8.1 Hub HTTP endpoints (consumed by browsers, scripts, future workers)

| Method | Path | Purpose | Response |
|---|---|---|---|
| `GET` | `/healthz` | Liveness probe | `200 ok` plaintext |
| `GET` | `/cams` | List all registered cameras + last-known status | JSON array |
| `GET` | `/cam/<id>/status` | Status for one camera | JSON (see below) |
| `GET` | `/cam/<id>/stream.mjpg` | Buffered MJPEG stream for one camera | `multipart/x-mixed-replace; boundary=frame` |
| `POST` | `/cam/<id>/toggle` | Set or flip the camera's desired state | `{"state":"on"\|"off"}` |

**`/cam/<id>/status` example:**

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
  "last_frame_age_ms": 67
}
```

CORS is wide-open (`Access-Control-Allow-Origin: *`) so any LAN page can drive the hub.

### 8.2 Hub ↔ camera WebSocket protocol

Endpoint: `ws://meer.local:5000/cam/<cam_id>` — one connection per camera.

**Camera → hub:**
- *binary message* — a JPEG frame. Last-writer-wins on the hub.
- *text JSON* — `{"type":"hello","cam_id":"front","capabilities":{"fps":15,"resolution":"640x480","jpeg_quality":70}}` once on connect.
- *text JSON* — `{"type":"status","cam_id":"front","state":"on","fps":15,"resolution":"640x480","battery_pct":87.5,"on_battery":false,"camera_available":true}` every ~5s.

**Hub → camera:**
- *text JSON* — `{"type":"set_state","state":"on"|"off"}` on connect and on every desired-state change.
- *text JSON* — `{"type":"hello_ack","cam_id":"front"}` (informational).

The hub holds the desired state across camera reconnects; on reconnect the camera receives the current desired state immediately.

## 9. MagicMirror² module

`MMM-DoorCam` is dual-role: it's both the on-mirror UI **and** the hub server. The browser-side module (`MMM-DoorCam.js`) renders the toggle and the MJPEG `<img>`; the helper (`node_helper.js`) runs in MagicMirror's Node process and is the actual hub that cameras connect into.

The module's source of truth lives in this repo at `mm_module/MMM-DoorCam/` and is symlinked into MagicMirror via `mm_module/install.sh` (see Section 11.8). One `MMM-DoorCam` config entry per camera is fine — they all share the same hub server (only the first instance's `hubPort` is used).

### Configuration (example `config.js` entry)
```js
{
  module: "MMM-DoorCam",
  position: "bottom_right",
  config: {
    camId: "front",                       // matches the camera's `camera.id`
    hubUrl: "http://meer.local:5000",     // base URL the browser uses for the MJPEG <img>
    hubPort: 5000,                        // port the node_helper hub binds to
    hideWhenOff: false,
    showToggleButton: true,
    showStatusBar: true,
    width: "320px",
    title: "Door Cam"
  }
}
```

### Behavior
- When feed is on: shows the live MJPEG stream from `hubUrl/cam/<camId>/stream.mjpg`.
- When the camera is offline (no WS connection to the hub): shows a `Camera "<id>" offline` placeholder.
- When the feed is off: either hides the module or shows a "Camera off" placeholder depending on `hideWhenOff`.
- Toggle button: sends `DOORCAM_TOGGLE_REQUEST` to the helper, which updates the desired state and forwards `set_state` down the WebSocket.
- Status updates are pushed from the helper to the browser via `socketNotification` — no client-side polling.
- Listens for MM2 notifications: `DOORCAM_TOGGLE`, `DOORCAM_ON`, `DOORCAM_OFF`.

### Module file layout
```
MMM-DoorCam/
  MMM-DoorCam.js        # browser module: UI + socketNotification client
  MMM-DoorCam.css       # styling
  node_helper.js        # hub server: HTTP+WS on :5000, per-cam state, frame buffer
  README.md
```

## 10. Future roadmap

The hub-and-spoke v0.2 design exists explicitly to support these phases without re-plumbing the camera side.

### Phase 2 — multi-camera + recording
- Add a second camera (e.g. `cam_id: porch`). Hub already routes by id; only config changes.
- Optional recording worker subscribes to the hub's frame stream for a given `cam_id` and writes clips to disk on the Mirror Pi.
- Retention policy (e.g. 7 days rolling) lives in the recorder, not the hub.

### Phase 3 — recognition & event log

#### Phase 3a — person detection + clip recording (in progress, M9a)
- The hub's `MMM-DoorCam/node_helper.js` runs YOLOv8n-int8 inference on the buffered frames in a `worker_threads` Worker (~2 fps, ~150 ms per inference on Pi 4 8 GB).
- A per-camera state machine (`session.js`) groups consecutive person detections into "sessions": idle → active on first detection, end on a 1.5 s grace window without a person.
- Each session writes a row to a local SQLite event log (`~/.mm-doorcam/events.db`) and records a video clip (`~/.mm-doorcam/clips/<cam_id>/<YYYY-MM-DD>/<HH-MM-SS>_person.mkv`) via an `ffmpeg` child process.
- New hub HTTP endpoints: `GET /cam/<id>/events`, `GET /events/<id>`, `GET /events/<id>/clip.mkv` (with `Range` support).
- Cameras stay oblivious — all ML stays on the hub.

#### Phase 3b — face recognition (future, M9b)
- Identify *who* the person is, not just *that* a person is there.
- Emits richer events like `unknown_face`, `known_face:jared` keyed off enrolled profiles (Phase 4).
- Door / package / animal classes follow the same hub-side worker pattern.

### Phase 4 — profiles & clearances
- Users enroll themselves by adding labeled face samples to the hub.
- Each profile has a "clearance level" that drives downstream actions.
- Repeat visitors (unknown, recurring faces) are auto-created as anonymous profiles that can later be named.

### Phase 5 — home automation integrations
- Auto-unlock deadbolt for known profiles with sufficient clearance (hardware TBD — Z-Wave or Zigbee bolt).
- MagicMirror notifications on door events (the hub can already push to MM via `socketNotification`).
- Optional: push notifications to phones when unknown faces arrive.

### Design principle for all future work
**Keep the camera units dumb. Put intelligence on the hub.** Cameras capture and stream. The Mirror Pi — the always-on, mains-powered hub — runs recognition, logging, rules, and integrations. This keeps camera units cheap, low-power, easy to replicate, and safe to run on PiSugar battery.

## 11. Pi setup instructions (camera unit)

These steps turn a blank microSD card into a working Door Cam.

### 11.1 Flash the OS
1. Download the Raspberry Pi Imager (https://www.raspberrypi.com/software/).
2. Choose **Raspberry Pi OS Lite (64-bit)** — no desktop.
3. Before writing, open advanced settings and set:
   - Hostname: `doorcam`
   - Username + password (memorable; you'll SSH as this user)
   - WiFi SSID and password (2.4 GHz network)
   - Locale / keyboard
   - Enable SSH
4. Flash the microSD, insert into the Pi Zero 2 W, attach the USB webcam via OTG adapter, power on.

### 11.2 First login and base update
```bash
ssh <user>@doorcam.local
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git python3-pip python3-venv v4l-utils avahi-daemon
```

### 11.3 Verify the camera is detected
```bash
ls /dev/video*            # should show /dev/video0
v4l2-ctl --list-devices   # shows your USB webcam
v4l2-ctl --list-formats-ext -d /dev/video0   # shows supported resolutions/fps
```

### 11.4 Install the PiSugar software
```bash
wget https://cdn.pisugar.com/release/pisugar-power-manager.sh
bash pisugar-power-manager.sh -c release
# follow the installer prompts. Test with:
echo "get battery" | nc -q 0 127.0.0.1 8423
```

### 11.5 Clone the Door Cam repo and install Python deps
```bash
git clone <your-repo-url> ~/doorcam
cd ~/doorcam/pi_client
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

### 11.6 Configure the hub URL
Copy the example config and point at the Mirror Pi:
```bash
sudo mkdir -p /etc/doorcam
sudo cp config.example.yml /etc/doorcam/config.yml
sudoedit /etc/doorcam/config.yml   # set hub.url and camera.id
```
Default `hub.url` is `ws://meer.local:5000` and default `camera.id` is `front`. Adjust if you renamed the Mirror Pi or you're adding a second camera.

### 11.7 Install the systemd unit
A `doorcam.service` file ships in the repo. Install and enable:
```bash
sudo cp deploy/doorcam.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now doorcam
sudo systemctl status doorcam
journalctl -fu doorcam   # should log "Connecting to hub at ws://meer.local:5000/cam/front"
```

### 11.8 Smoke test
From the Mirror Pi (or any LAN device):
```bash
curl http://meer.local:5000/healthz                     # -> ok
curl http://meer.local:5000/cams                        # lists registered cameras
curl http://meer.local:5000/cam/front/status            # JSON status
curl -X POST http://meer.local:5000/cam/front/toggle    # -> {"state":"on"}
# Open the stream in a browser:
#   http://meer.local:5000/cam/front/stream.mjpg
```

### 11.9 Install the MagicMirror module
On the Mirror Pi (or wherever the DoorCamera repo also lives — it has to host the hub):
```bash
cd ~/DoorCamera
./mm_module/install.sh                  # auto-detects ~/MagicMirror
# or, if MM lives elsewhere:
./mm_module/install.sh /path/to/MagicMirror
```
The script symlinks `<MagicMirror>/modules/MMM-DoorCam` into this repo and creates an internal `node_modules` symlink so the helper can resolve `ws` and `node_helper` from MagicMirror's bundle. Then add the `MMM-DoorCam` entry shown in Section 9 to `~/MagicMirror/config/config.js` and restart MagicMirror.

## 12. `requirements.txt` (camera Pi)

```
# --- Hub link (single outbound WebSocket) ---
websockets==12.*

# --- Camera capture ---
opencv-python-headless==4.10.*   # headless build = no GUI deps, lighter install
numpy<2.0                         # pinned for OpenCV compatibility on ARM

# --- Imaging helpers ---
Pillow==10.*

# --- Config + utilities ---
PyYAML==6.*

# --- System/process integration ---
psutil==5.*                       # process + system metrics

# --- Tests ---
pytest==8.*
```

Notes on dependency choices:
- `websockets` is the only network library on the camera; there's no inbound HTTP server here anymore.
- `opencv-python-headless` is ~100 MB smaller than `opencv-python` because it omits GUI libs we don't need on a headless Pi.
- `numpy<2.0` avoids a current ARM/wheel incompatibility with some OpenCV builds. Revisit once upstream catches up.
- PiSugar is **not** a Python package — we talk to its local daemon over a TCP socket (port 8423) with plain Python `socket` calls, so nothing to pip install for it.

### Hub-side dependencies (MagicMirror Pi)
None to install separately — `ws` is already in MagicMirror's `node_modules`. The hub is a single `node_helper.js`; `mm_module/install.sh` exposes it to MagicMirror via two symlinks.

## 13. Implementation plan (milestones)

| Milestone | Status | What "done" looks like |
|---|---|---|
| **M1 — Hardware bring-up** | done (v0.1) | Pi Zero 2 W flashed, on WiFi, reachable at `doorcam.local`. USB webcam detected. PiSugar reports battery over its socket. |
| **M2 — Capture + stream** | done (v0.1) | Python service opens the camera and produces JPEGs end to end. |
| **M3 — Viewer + toggle** | done (v0.1) | Toggle works, status reports PiSugar battery. |
| **M4 — Productionize** | done (v0.1) | Config file, `systemd` unit, auto-restart on crash, device released when off. |
| **M5 — MagicMirror module** | done (v0.1) | `MMM-DoorCam` rendered the camera's stream and toggled it. |
| **M6 — Hardening** | done (v0.1) | Logging, repo README, `requirements.txt` pinned. |
| **M7 — Hub inversion (v0.2)** | done | Mirror Pi runs the hub (`MMM-DoorCam/node_helper.js` on `:5000`). Camera is a thin async WebSocket publisher; no inbound port. Module tracked in this repo at `mm_module/MMM-DoorCam/`. PRD updated. |
| **M8 — Multi-camera + recording** | next | Stand up a second camera with `cam_id: porch`. Add a hub-side recording worker that taps the buffered frames. |
| **M9a — Person detection + clip recording** | in progress | Hub-side `worker_threads` detector runs YOLOv8n-int8 on buffered frames; per-event clips land in `~/.mm-doorcam/clips/`; events queryable at `GET /cam/<id>/events`. |
| **M9b — Face recognition** | future | Identity-aware detection: `unknown_face`, `known_face:<id>` events tied to Phase 4 profiles. |

## 14. Risks & open questions

- **Thermal/CPU on Pi Zero 2 W:** sustained capture + JPEG encode + WS send may push CPU high. Mitigation: cap at 15 fps and 640×480; monitor with `vcgencmd measure_temp`.
- **USB power:** USB webcams can draw real current. If the Pi browns out, we'll need a powered USB hub or a camera with lower draw.
- **WiFi range:** the Zero 2 W radio is weaker than the Pi 4's. If the doorway has poor signal, a USB WiFi adapter or repositioning may be needed.
- **No auth:** acceptable for a trusted LAN. Before any non-LAN exposure we'd add a shared secret in the WS hello and TLS termination on the hub.
- **PiSugar longevity:** battery capacity degrades. Plan a yearly health check (the camera reports `battery_pct` to the hub on every status tick — easy to log over time).
- **Hub is a single point of failure:** if the Mirror Pi is down, no cameras are visible. Acceptable for the home setup but worth noting before scaling beyond it.
- **Symlink-based MM install:** the hub helper resolves `ws` and `node_helper` via a `node_modules` symlink into MagicMirror's bundle. If MM ever moves to ESM-only or to a sandboxed module loader this needs a rethink.

## 15. Glossary

- **MJPEG** — Motion JPEG. A video format where each frame is a standalone JPEG. Browsers can render a continuous MJPEG HTTP response directly in an `<img>` tag.
- **UVC** — USB Video Class. A standard that lets most USB webcams work on Linux (via the `uvcvideo` kernel driver) without extra drivers.
- **V4L2** — Video4Linux2. The kernel API for interacting with video capture devices on Linux.
- **MM2** — MagicMirror², the smart-mirror platform we're integrating with.
- **PiSugar** — third-party UPS/battery HAT for Raspberry Pi, exposes state over a local socket.
- **mDNS** — multicast DNS, lets us reach Pis at `meer.local` / `doorcam.local` without static IPs.
- **Hub** — the always-on Mirror Pi running `MMM-DoorCam`'s `node_helper.js`. Owns the desired state and the latest-frame buffer per camera.
- **Publisher** — the Python process on a camera Pi that maintains the WebSocket to the hub.
- **`cam_id`** — string identifier a camera registers under (e.g. `front`, `porch`). Keys both the WS endpoint and all HTTP routes.
