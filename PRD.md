# Door Cam — Product Requirements Document

**Project:** Door Cam (custom Raspberry Pi security camera with MagicMirror integration)
**Owner:** Jared
**Status:** MVP in planning
**Last updated:** 2026-04-17
**Document version:** 0.1 (living document)

---

## 1. Overview

Door Cam is a custom, low-cost security camera built on a Raspberry Pi Zero 2 W. The camera sits at the front door and streams live video over the local WiFi network to:

1. A simple web page that can be viewed from any device on the network.
2. A custom module on a MagicMirror² (MM2) display running on a separate Raspberry Pi.

The MVP is a single-camera, single-network system with a manual on/off toggle for the feed. It is intentionally scoped to prove out the hardware, capture pipeline, and viewing experience before layering on a larger multi-camera security platform with recognition, profiles, and home-automation integrations.

## 2. Goals & Non-goals

### Goals (MVP)
- Reliably capture video from a USB webcam attached to a Pi Zero 2 W at the front door.
- Stream the feed over WiFi to any browser on the LAN with acceptable latency (target: under 2 seconds).
- Provide a manual toggle (on/off) for the feed, exposed both via the camera's built-in web UI and the MagicMirror module.
- Keep the camera unit lightweight — no on-device recognition, minimal CPU/RAM load, minimal dependencies — so it runs comfortably on 512 MB of RAM.
- Survive short power outages using the PiSugar backup battery and resume streaming automatically when power is restored.
- Provide clear, reproducible setup instructions so a fresh Pi can be provisioned end-to-end.

### Non-goals (MVP)
- No cloud streaming or remote (off-LAN) access.
- No recording, clip storage, or event timelines.
- No face/object recognition on-device.
- No user accounts, authentication, or role-based access — MVP assumes trusted home LAN.
- No encryption of the stream (HTTP only) — will revisit when the system grows beyond one unit.
- No multi-camera orchestration, no central server. The camera is self-contained and serves its own feed.

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

## 4. System architecture (MVP)

```
+------------------------+            +--------------------------+
|  Door Cam (Pi Zero 2W) |            |  Viewing Pi (MM2)        |
|                        |            |                          |
|  USB webcam            |   MJPEG    |  MagicMirror² module     |
|    |                   |  over HTTP |   <img src="mjpg url"/>  |
|    v                   |----------->|                          |
|  Python capture svc    |            +--------------------------+
|    |                   |
|  Flask server          |   Any browser on LAN
|    |  /stream.mjpg     |---------->  http://doorcam.local:5000/
|    |  /toggle          |
|    |  /status          |
|  PiSugar (battery)     |
+------------------------+
```

**Single-process architecture:** one Python program on the Pi runs (a) the camera capture loop, (b) the Flask HTTP server, and (c) the toggle state machine. No separate backend server is required for the MVP; the camera serves itself. A "server tier" is a future feature (see Section 10).

### Why MJPEG over HTTP instead of WebSockets?

This is a common question when first building a streaming system, so worth documenting:

- **MJPEG over HTTP** sends a never-ending `multipart/x-mixed-replace` response — each "part" is a full JPEG frame. A browser's plain `<img src="...">` tag natively renders this with zero JavaScript. It is dead-simple, has no handshake complexity, and works well on constrained hardware. The trade-off is higher bandwidth than modern codecs (no inter-frame compression).
- **WebSockets** give you a persistent, bidirectional channel. They are the right tool for *control messages* (e.g., "toggle the feed off"), chat, telemetry — things where the server pushes small events and the client pushes commands. They are *not* needed to carry the video itself.
- **WebRTC** is the lowest-latency option but the most complex (STUN/TURN, SDP negotiation, peer connections). Overkill for a LAN-only MVP.

**Decision for MVP:** use MJPEG over HTTP for the video stream, and plain REST endpoints (`POST /toggle`) for control. If we later want sub-second latency or better compression, we can migrate to WebRTC or HLS. No WebSockets needed in the MVP, but we'll introduce them once we have a central server pushing status updates to multiple clients.

## 5. MVP feature list

| # | Feature | Description |
|---|---|---|
| F1 | USB camera capture | Read frames from `/dev/video0` via V4L2 (OpenCV wrapper). |
| F2 | MJPEG HTTP stream | Continuous stream served at `GET /stream.mjpg`. |
| F3 | Viewer web page | `GET /` returns a minimal HTML page with the stream embedded and a toggle button. |
| F4 | Manual on/off toggle | `POST /toggle` flips feed state. When off, the camera stops encoding/streaming and returns a black frame or 503 to current viewers. |
| F5 | Status endpoint | `GET /status` returns JSON: `{state, uptime, fps, resolution, battery_pct}`. |
| F6 | PiSugar battery reporting | Read battery % from the PiSugar daemon and include in `/status`. |
| F7 | MagicMirror² module | Custom MM2 module that embeds the live stream and exposes a toggle. Feed reflects whatever state the camera is in. |
| F8 | Auto-start on boot | Camera service runs as a `systemd` unit and comes up on boot / after power loss. |
| F9 | mDNS / .local hostname | Camera is reachable at `doorcam.local` so no IP-address hunting. |

## 6. Non-functional requirements

- **Latency:** under 2 seconds glass-to-glass on LAN at 640×480 @ 15 fps.
- **CPU/RAM budget on Pi Zero 2 W:** camera process stays under ~40% CPU average and ~150 MB RAM.
- **Startup time:** camera reachable within 90 seconds of powering on.
- **Resilience:** service restarts automatically on crash (`systemd Restart=on-failure`).
- **Configurability:** single YAML or INI config file (`/etc/doorcam/config.yml`) for resolution, fps, port, hostname, and toggle default state.

## 7. Tech stack

### Camera unit (Pi Zero 2 W)
- **OS:** Raspberry Pi OS Lite (64-bit), Bookworm or later — headless, no desktop.
- **Language:** Python 3.11+.
- **Web framework:** Flask (minimal overhead, easy routing).
- **Camera I/O:** OpenCV (`cv2.VideoCapture`) for USB UVC cameras. Fallback: raw V4L2 via `v4l2-ctl` if OpenCV proves too heavy.
- **Process manager:** `systemd`.
- **Battery integration:** PiSugar daemon (`pisugar-server`) over its local socket API.
- **Discovery:** `avahi-daemon` for `.local` mDNS.

### Viewer
- **MVP viewer:** single HTML page served by Flask. Plain HTML + a few lines of vanilla JS for the toggle button (fetch → `POST /toggle`). No build step, no framework.
- **MagicMirror² module:** Node.js module (MM2's native module system). Embeds the MJPEG stream in an `<img>` and calls the camera's REST endpoints for toggle/status.

### Why not Node on the camera too?
Tempting for stack uniformity, but Python's Pi ecosystem (OpenCV, picamera2, later `face_recognition`, `dlib`, etc.) is substantially stronger. The MagicMirror module will be Node because MM2 requires it — that's fine; the interface between them is plain HTTP.

## 8. API / Interfaces

All endpoints served by the camera Pi on port 5000 (configurable).

| Method | Path | Purpose | Response |
|---|---|---|---|
| `GET` | `/` | Viewer HTML page | `text/html` |
| `GET` | `/stream.mjpg` | MJPEG video stream | `multipart/x-mixed-replace; boundary=frame` |
| `POST` | `/toggle` | Flip feed state on/off | `{state: "on" \| "off"}` |
| `GET` | `/status` | Current state + telemetry | JSON (see below) |
| `GET` | `/healthz` | Liveness probe | `200 OK` plaintext |

**`/status` example:**

```json
{
  "state": "on",
  "uptime_seconds": 12345,
  "fps": 15,
  "resolution": "640x480",
  "battery_pct": 87,
  "on_battery": false
}
```

## 9. MagicMirror² module

A custom module named `MMM-DoorCam` installed into the MagicMirror `modules/` directory on the viewing Pi.

### Configuration (example `config.js` entry)
```js
{
  module: "MMM-DoorCam",
  position: "bottom_right",
  config: {
    cameraUrl: "http://doorcam.local:5000",
    startEnabled: false,      // feed off by default on the mirror
    pollStatusEvery: 5000,    // ms
    hideWhenOff: true
  }
}
```

### Behavior
- When feed is on: shows the live MJPEG stream in the allotted region.
- When feed is off: either hides the module or shows a placeholder ("Camera off") depending on `hideWhenOff`.
- Exposes a toggle affordance (button, or MM2 notification from another module / voice command in the future) that calls `POST /toggle`.
- Polls `/status` every few seconds to reflect the true camera state (so toggling from the web UI is also reflected on the mirror).

### MM2 module file layout
```
MMM-DoorCam/
  MMM-DoorCam.js        # client-side module (renders the stream)
  node_helper.js        # server-side helper (makes HTTP calls to camera)
  MMM-DoorCam.css       # styling
  README.md
```

## 10. Future roadmap (post-MVP)

This section exists so MVP decisions don't paint us into a corner. Each item is a future feature, not a commitment.

### Phase 2 — central server
- Stand up a "home security server" on one Pi (likely a Pi 4 with more RAM).
- All cameras stream to the server instead of (or in addition to) serving themselves.
- Server handles recording, retention, and fanning the feed out to multiple viewers.
- Camera units remain lightweight — they only push frames upstream and don't do recognition.

### Phase 3 — recognition & event log
- Server runs face/person detection on incoming frames.
- Emits events like `person_detected`, `unknown_face`, `known_face:jared` to an event log (SQLite or Postgres).
- Cameras remain oblivious — all ML happens server-side.

### Phase 4 — profiles & clearances
- Users can enroll themselves by adding labeled face samples.
- Each profile has a "clearance level" that drives downstream actions.
- Repeat visitors (unknown, recurring faces) are auto-created as anonymous profiles that can later be named.

### Phase 5 — home automation integrations
- Auto-unlock deadbolt for known profiles with sufficient clearance (hardware TBD — Z-Wave or Zigbee bolt).
- MagicMirror notifications on door events.
- Optional: push notifications to phones when unknown faces arrive.

### Design principle for all future work
**Keep the camera units dumb.** They capture and stream. Everything else — recognition, logging, rules, integrations — runs on the central server. This keeps camera units cheap, low-power, and easy to replicate.

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
cd ~/doorcam
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

### 11.6 Install the systemd unit
A `doorcam.service` file ships in the repo. Install and enable:
```bash
sudo cp deploy/doorcam.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now doorcam
sudo systemctl status doorcam
```

### 11.7 Smoke test
From any device on the LAN:
- Open `http://doorcam.local:5000/` — viewer page loads, stream visible.
- Click **Toggle** — stream stops/starts.
- `curl http://doorcam.local:5000/status` returns JSON.

### 11.8 Setup instructions (MagicMirror unit)
On the MM2 Pi:
```bash
cd ~/MagicMirror/modules
git clone <your-module-repo-url> MMM-DoorCam
cd MMM-DoorCam
npm install                # only if the module has Node deps
```
Add the `MMM-DoorCam` entry shown in Section 9 to `~/MagicMirror/config/config.js`, then restart MagicMirror.

## 12. `requirements.txt` (initial)

```
# --- Web server ---
Flask==3.0.*

# --- Camera capture ---
opencv-python-headless==4.10.*   # headless build = no GUI deps, lighter install
numpy<2.0                         # pinned for OpenCV compatibility on ARM

# --- Imaging helpers ---
Pillow==10.*

# --- Config + utilities ---
PyYAML==6.*
python-dotenv==1.*

# --- System/process integration ---
psutil==5.*                       # process + system metrics for /status

# --- Optional: typing / lint during dev ---
# (kept out of production install; move to requirements-dev.txt later)
```

Notes on dependency choices:
- `opencv-python-headless` is ~100 MB smaller than `opencv-python` because it omits GUI libs we don't need on a headless Pi.
- `numpy<2.0` avoids a current ARM/wheel incompatibility with some OpenCV builds. Revisit once upstream catches up.
- PiSugar is **not** a Python package — we talk to its local daemon over a TCP socket (port 8423) with plain Python `socket` calls, so nothing to pip install for it.

## 13. Implementation plan (milestones)

| Milestone | What "done" looks like |
|---|---|
| **M1 — Hardware bring-up** | Pi Zero 2 W flashed, on WiFi, reachable at `doorcam.local`. USB webcam detected. PiSugar reports battery over its socket. |
| **M2 — Capture + stream** | A 30-line Python script opens the camera, serves MJPEG at port 5000. Viewable in browser. No toggle, no UI. |
| **M3 — Viewer page + toggle** | Minimal HTML page with embedded stream and a working toggle button wired to `POST /toggle`. `/status` endpoint returns JSON including PiSugar battery. |
| **M4 — Productionize** | Config file, `systemd` unit, auto-start on boot, auto-restart on crash. Graceful behavior when toggled off (frees the camera, not just hides). |
| **M5 — MagicMirror module** | `MMM-DoorCam` renders the stream and toggles the camera via its `node_helper`. State reflected live. |
| **M6 — Hardening** | Logging with rotation, basic rate-limiting on `/toggle`, documentation polish, repo README, `requirements.txt` locked. |

Each milestone is a natural commit point and produces something testable on its own.

## 14. Risks & open questions

- **Thermal/CPU on Pi Zero 2 W:** sustained MJPEG encoding plus network I/O may push CPU high. Mitigation: cap at 15 fps and 640×480 for MVP; monitor with `vcgencmd measure_temp`.
- **USB power:** USB webcams can draw real current. If the Pi browns out, we'll need a powered USB hub or a camera with lower draw. Check this during M1.
- **WiFi range:** the Zero 2 W radio is weaker than the Pi 4's. If the doorway has poor signal, a USB WiFi adapter or repositioning may be needed.
- **No auth on MVP:** acceptable for a trusted LAN but must be addressed before the system is exposed beyond the LAN. Tracked as a prerequisite for Phase 2 (central server).
- **PiSugar longevity:** battery capacity degrades. Plan a yearly health check (log battery capacity in `/status`).
- **Single point of failure:** one Pi, one camera. That's fine for MVP; multi-camera is Phase 2.

## 15. Glossary

- **MJPEG** — Motion JPEG. A video format where each frame is a standalone JPEG. Browsers can render a continuous MJPEG HTTP response directly in an `<img>` tag.
- **UVC** — USB Video Class. A standard that lets most USB webcams work on Linux (via the `uvcvideo` kernel driver) without extra drivers.
- **V4L2** — Video4Linux2. The kernel API for interacting with video capture devices on Linux.
- **MM2** — MagicMirror², the smart-mirror platform we're integrating with.
- **PiSugar** — third-party UPS/battery HAT for Raspberry Pi, exposes state over a local socket.
- **mDNS** — multicast DNS, lets us reach the Pi at `doorcam.local` without static IPs.
