# SecurityLux — Product Requirements Document

**Project:** SecurityLux — self-hosted, LAN-only home security camera system
**Owner:** Jared
**Status:** v4 — MVP feature-complete; event capture, storage policy, zones, descriptions, door light
**Last updated:** 2026-07-25
**Document version:** 0.4 (living document)

> **Architecture history.**
> - **v0.1:** each camera Pi ran its own Flask server that the Mirror polled.
> - **v0.2:** inverted — the MagicMirror Pi (`meer.local`) hosted the hub; cameras connected *out* to it over a single WebSocket. This required users to also run MagicMirror.
> - **v0.3:** the hub is split out into a standalone Node.js service (`hub/`). It can run anywhere on the LAN — a spare Pi, a desktop, a NUC, or alongside MagicMirror as a separate systemd unit. The MagicMirror module (`mm_module/MMM-SecurityLuxDisplay/`) became an *optional* pure-browser display client. Users without a MagicMirror get a perfectly usable system via the hub's built-in dashboard at `http://<hub>:5000/`.
> - **v0.4 (current):** MVP feature-complete. Event capture gained pre/post-roll so clips include the walk-up; storage gained a three-limit retention policy so a small SD card can't fill silently; detections are threaded into tracks and named zones so events carry plain-English descriptions; an optional NeoPixel strip on the camera Pi signals presence with escalating patterns; cameras can be restarted or rebooted from the web UI; profiles and clearances are stored and editable. Settings moved from a read-only YAML file to a validated schema editable in the browser.

---

## 1. Overview

SecurityLux is a self-hosted, LAN-only home security camera system. Camera units sit at doorways or other vantage points; a **hub** somewhere on the home network buffers their frames, optionally runs on-host person detection, records per-event video clips, and exposes everything over HTTP for browsers, scripts, and other consumers. No cloud, no accounts, no subscriptions.

It's three independent components:

1. **`hub/`** — the standalone Node.js server. Camera nodes connect into it over WebSocket; the hub buffers the latest JPEG per camera and re-fans it as MJPEG to any number of HTTP viewers. Runs detection (`onnxruntime-node`), recording (`ffmpeg`), the SQLite event log, and a self-contained dashboard. Runs on any Linux host with Node 18+.
2. **`camera_node/`** — a thin Python publisher for low-power Raspberry Pis (designed for the Pi Zero 2 W). One per camera. Pushes frames over a single outbound WebSocket; accepts `set_state` commands back. No inbound port.
3. **`mm_module/MMM-SecurityLuxDisplay/`** — *optional* MagicMirror² module that displays one camera on a mirror. Pure browser-side; talks to the hub over HTTP. Skip it entirely if you don't run MagicMirror.

The protocol is keyed by `cam_id` so additional cameras drop in as a config change on a new Pi. The hub is the obvious home for future intelligence — face recognition, profiles, event-driven automation — because it's the always-on, mains-powered piece of the system.

## 2. Goals & Non-goals

### Goals
- Reliably capture video from a USB webcam attached to a Pi Zero 2 W at the front door.
- Push the feed to SecurityLuxHub with acceptable latency (target: under 2 seconds glass-to-glass).
- Centralize control and viewing through the standalone hub so one always-on LAN device owns camera state, detection, recordings, and dashboard access.
- Keep the camera unit lightweight — no on-device recognition, minimal CPU/RAM load, minimal dependencies — so it runs comfortably on 512 MB of RAM and on battery when needed.
- Survive short power outages using the PiSugar backup battery and resume streaming automatically when power is restored.
- Provide clear, reproducible setup instructions so a fresh camera Pi can be provisioned end-to-end.

### Non-goals (current scope)
- No cloud streaming or remote (off-LAN) access.
- No cloud services of any kind. Event descriptions, sunrise/sunset, and detection all run on the hub with no internet route required.
- No face/object recognition on the camera itself; that's hub work.
- No automatic face recognition yet — profiles and enrollment exist and work, but the embedding models are not published (see M9b).
- No door/lock actuation. Clearance levels are recorded for it; nothing acts on them.
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
+--------------------------+              +----------------------------------+
|  camera_node (Pi Zero 2W)|              |  SecurityLuxHub (Linux + Node)   |
|                          |              |  any reachable LAN host          |
|  USB webcam              |              |                                  |
|    |                     | single       |  hub.js (entry)                  |
|    v                     | outbound WS  |    + server.js (HTTP+WS :5000)   |
|  CameraManager (capture) |              |    + detector + worker (YOLO)    |
|    |                     |==============>|    + session + recorder (ffmpeg) |
|    v                     | binary JPEG  |    + store (SQLite events.db)    |
|  Publisher (asyncio WS)  |              |    + web/ dashboard              |
|    |                     |<--------------+   text JSON commands             |
|  PiSugar (battery)       |   (set_state)|                                  |
+--------------------------+              +----------------------------------+
                                                  ^         ^         ^
                                                  |         |         |
                                                  | HTTP    |         | HTTP
                                                  |         |         |
                                              dashboard   curl /    MagicMirror
                                              (any        scripts   (optional;
                                              browser)              MMM-
                                                                    SecurityLuxDisplay
                                                                    polls /status,
                                                                    renders MJPEG)
```

**Hub-and-spoke architecture.** Whichever Linux host runs `hub/` is the always-on hub for the household's cameras. The hub owns:

- the desired on/off state for each camera,
- the latest-frame buffer (last-writer-wins, no per-client queueing),
- the SQLite event log + clip files,
- the HTTP surface that browsers, scripts, MagicMirror modules, and future workers consume.

The camera_node runs only what it must: capture, encode, and a thin async WebSocket publisher. When the hub commands `state: off` the camera releases the V4L2 device, dropping draw to near-idle — important because the camera may run on PiSugar battery for short windows.

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
| F3 | Hub frame buffer + MJPEG re-fan | SecurityLuxHub buffers the latest frame per camera and re-serves it as `GET /cam/<id>/stream.mjpg` (multipart MJPEG) to any number of HTTP viewers. |
| F4 | Manual on/off toggle | `POST /cam/<id>/toggle` (or the MM module's button) updates the hub's desired state and forwards `{type:"set_state",state:...}` down the WebSocket. The camera releases the V4L2 device when `off`. |
| F5 | Status endpoint | `GET /cam/<id>/status` returns JSON with `{state, connected, fps, resolution, battery_pct, on_battery, camera_available, …}` from the hub's last-known view. |
| F6 | PiSugar battery reporting | Camera reads battery % + charging from the PiSugar daemon and includes both in periodic status messages it pushes to the hub. |
| F7 | MagicMirror² module | `MMM-SecurityLuxDisplay` is an optional browser-only display client that renders the MJPEG stream and can expose the toggle. |
| F8 | Auto-start on boot | Camera publisher runs as a `systemd` unit and comes up on boot / after power loss. The hub runs as its own service. |
| F9 | mDNS / .local hostnames | Camera resolves the hub at `meer.local`; the camera Pi continues to be reachable at `securitylux-cam.local` for SSH/admin. |
| F10 | `cam_id` keyed protocol | Every WS connection and HTTP route is namespaced by `cam_id`. Adding a second camera is a config change on the new Pi (`camera.id: porch`) and a second `MMM-SecurityLuxDisplay` entry on the mirror. |
| F11 | Event capture with pre/post-roll | The hub keeps a rolling in-memory buffer of the last N seconds per camera. A clip starts with buffered pre-roll frames so it opens on the approach, not on someone already standing in frame, and keeps recording for a post-roll window after they leave. |
| F12 | Event thumbnails | A ~10 KB JPEG per event, taken from mid-pre-roll (where the subject is usually cleanly visible rather than half out of frame). Makes the event list scannable. |
| F13 | Three-limit storage policy | `retentionDays`, `maxTotalGB`, and `minFreeGB` are enforced independently. The budget reclaims oldest video first while keeping the event rows; the free-space floor pauses recording rather than letting a full disk break the hub. |
| F14 | Named zones | Polygons drawn on a camera snapshot in the web UI and labelled ("trash room door", "driveway"). `ignore` zones suppress detections entirely — the release valve for a swaying branch or passing traffic. Membership is tested at the subject's feet, not their centre. |
| F15 | Tracking + behaviour classification | Detections are threaded into tracks across ticks and classified as passing / approaching / present / dwelling / loitering, which is what distinguishes someone walking past from someone standing at the door. |
| F16 | Natural-language descriptions | Composed locally from zone transitions, dwell time, direction, and time of day: *"Someone approached the trash room door and stood there for 12 seconds."* Regenerable over history after zones are renamed. |
| F17 | NeoPixel door light | Optional WS281x strip on the camera Pi, driven over SPI (no root). Five escalating patterns keyed to the behaviour classes. Every command carries a TTL so the light fails dark if the hub goes quiet. |
| F18 | Remote camera control | `POST /cam/<id>/restart` (fast — restarts the publisher) and `POST /cam/<id>/reboot` (reboots the Pi via a scoped sudoers rule) from the web UI. |
| F19 | Motion pre-filter | Cheap frame-differencing gate ahead of the detector, inside the worker so it skips inference while still paying only for the decode. Forced inference while a session is active so a motionless person is never lost. |
| F20 | Camera-offline alerting | A camera that stops reporting for N minutes logs a `camera_offline` event. A camera that's been down for days is worse than no camera, because you believe you're covered. |
| F21 | Browser-editable settings | A validated schema drives both the API and the UI controls, so the two cannot drift. Resolution order: defaults → `config.yml` → saved values → per-camera overrides. |
| F22 | Profiles and clearances | People, clearance levels 0-3, and enrolled face samples. Faces can be added from an event thumbnail in one click. Recognition itself is scaffolded but not active (M9b). |
| F23 | Nightly database backup | Seven rotating `VACUUM INTO` copies of `events.db`. Clips are re-recordable; zones, settings, and profiles are not. |
| F24 | Event webhook | Optional outbound POST per finalized event, for ntfy / Home Assistant / a shell script. |

## 6. Non-functional requirements

- **Latency:** under 2 seconds glass-to-glass on LAN at 640×480 @ 15 fps.
- **CPU/RAM budget on Pi Zero 2 W:** camera process stays under ~40% CPU average and ~150 MB RAM. With the feed `off` the publisher only keeps the WS open and idles — well under 1% CPU.
- **Startup time:** camera registered with hub within 90 seconds of powering on.
- **Resilience:**
    - publisher: `systemd Restart=on-failure` plus in-process WS reconnect with exponential backoff (1s → 30s).
    - hub: runs as an OS service; survives camera disconnects (state preserved, frame buffer cleared, browser sees an "offline" placeholder until the camera reconnects).
- **Configurability:** single YAML config file (`/etc/camera-node/config.yml` on the camera) for `hub.url`, `camera.id`, resolution, fps. The hub's bind port, detection, recording, and storage settings live in `hub/config.example.yml` / the installed hub config.

## 7. Tech stack

### Camera unit (Pi Zero 2 W)
- **OS:** Raspberry Pi OS Lite (64-bit), Bookworm or later — headless, no desktop.
- **Language:** Python 3.11+ (`asyncio`).
- **Networking:** `websockets` (Python WS client). The publisher is a single async loop; no Flask, no inbound ports.
- **Camera I/O:** OpenCV (`cv2.VideoCapture`) for USB UVC cameras. Fallback: raw V4L2 via `v4l2-ctl` if OpenCV proves too heavy.
- **Process manager:** `systemd` — restarts the publisher on crash; the publisher itself handles transient hub disconnects internally.
- **Battery integration:** PiSugar daemon (`pisugar-server`) over its local socket API.
- **Discovery:** `avahi-daemon` for `.local` mDNS — used to resolve the hub at `meer.local`.

### Hub (standalone LAN host)
- **Runs as a standalone service.** The hub is `hub/src/hub.js`, installed as `security-lux-hub.service` on Linux or a LaunchAgent on macOS.
- **Language:** Node.js 18+.
- **Networking:** the standard `http` module + the `ws` package. Binds its own port (default `5000`) for camera ingest, dashboard access, and API clients.
- **Browser UI:** the built-in dashboard in `hub/web/` renders live MJPEG, status, detection controls, and recorded events. The optional MagicMirror module polls the same HTTP API.

### Why split Python on the camera and Node on the hub?
Python's Pi ecosystem (OpenCV, picamera2, later `face_recognition`, `dlib`) is what makes camera-side work easy. Node works well for the hub because the HTTP, WebSocket, worker-thread, and dashboard pieces are straightforward there. The interface between camera and hub is a tiny WebSocket protocol (binary frames + a handful of JSON message types).

## 8. API / Interfaces

All consumer-facing endpoints live on the **hub** (`meer.local` in these examples, port 5000). Cameras connect into the hub over WebSocket; they expose nothing themselves.

### 8.1 Hub HTTP endpoints (consumed by browsers, scripts, future workers)

**Cameras**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness probe → `200 ok` plaintext |
| `GET` | `/cams` | All registered cameras + last-known status |
| `GET` | `/cam/<id>/status` | Status for one camera (see below) |
| `GET` | `/cam/<id>/stream.mjpg` | Live MJPEG (`multipart/x-mixed-replace`) |
| `GET` | `/cam/<id>/snapshot.jpg` | Newest buffered frame as a single JPEG |
| `POST` | `/cam/<id>/toggle` | Set or flip desired state → `{"state":"on"\|"off"}` |
| `POST` | `/cam/<id>/detection` | Per-camera detection mute — `{enabled: bool}` |
| `POST` | `/cam/<id>/restart` | Restart the camera's publisher service |
| `POST` | `/cam/<id>/reboot` | Reboot the camera Pi |
| `POST` | `/cam/<id>/led/test` | Fire a door-light pattern to check wiring |
| `GET`/`PUT` | `/cam/<id>/settings` | Per-camera setting overrides |
| `GET`/`PUT` | `/cam/<id>/zones` | Named zones for this camera |

**Events**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/events` | Filterable event list (`cam`, `since`, `until`, `type`, `behavior`, `clips`, `limit`, `offset`) |
| `GET` | `/cam/<id>/events` | Same, scoped to one camera |
| `GET` | `/events/latest?cam=<id>` | Most recent event — powers the mirror display |
| `GET` | `/events/<id>` | One event |
| `GET` | `/events/<id>/clip.mp4` | Clip, with `Range` support |
| `GET` | `/events/<id>/thumb.jpg` | Event thumbnail |
| `POST` | `/events/<id>/redescribe` | Rewrite one description from current zones |
| `POST` | `/events/redescribe` | Rewrite descriptions in bulk (`{cam}`) |
| `DELETE` | `/events/<id>` | Delete an event and its files |

**Settings, storage, detection, profiles**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/settings/schema` | The setting declarations the UI renders from |
| `GET`/`PUT` | `/settings` | Hub-wide settings |
| `GET`/`POST` | `/detection` | Hub-wide detector on/off + status |
| `GET` | `/storage` | Usage, limits, per-camera breakdown, projected runway |
| `POST` | `/storage/prune` | Run the retention sweep now |
| `POST` | `/storage/backup` | Write a dated `events.db` copy |
| `GET`/`POST` | `/profiles` | List / create profiles |
| `GET`/`PATCH`/`DELETE` | `/profiles/<id>` | One profile |
| `GET`/`POST` | `/profiles/<id>/samples` | Face samples (`{eventId}` or `{imageBase64}`) |
| `DELETE` | `/profiles/<id>/samples/<sid>` | Remove a sample |
| `GET` | `/recognition` | Face-recognition availability |

**`/cam/<id>/status` example:**

```json
{
  "cam_id": "front",
  "name": "Front Door",
  "state": "on",
  "connected": true,
  "fresh": true,
  "fps": 15,
  "resolution": "640x480",
  "battery_pct": 87.5,
  "on_battery": false,
  "camera_available": true,
  "led_available": true,
  "uptime_s": 4821,
  "last_frame_age_ms": 67,
  "current_detection": { "class": "person", "confidence": 0.91, "bbox": {}, "count": 1 },
  "detection_enabled": true,
  "recording_enabled": true,
  "recording_paused": false,
  "behavior": "dwelling",
  "led_stage": 3,
  "person_count": 1,
  "session_active": true,
  "reconnects": 2
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
- *text JSON* — `{"type":"led_config","enabled":true,"count":8,"maxBrightness":0.4}` on connect and whenever LED settings change.
- *text JSON* — `{"type":"led","stage":3,"pattern":"pulse","color":[255,160,40],"brightness":0.34,"periodMs":1100,"ttlMs":8000}` on every escalation change, and re-sent at half the TTL while a stage is held.
- *text JSON* — `{"type":"restart_service"}` — the publisher exits cleanly; systemd restarts it.
- *text JSON* — `{"type":"reboot"}` — reboots the Pi.

The hub holds the desired state across camera reconnects; on reconnect the camera receives the current desired state immediately.

**Why LED commands carry a TTL.** The camera decays the strip to idle if it hasn't heard from the hub within `ttlMs`. If the hub crashes mid-event or WiFi drops while someone is standing at the door, the failure mode is "the light goes out" rather than "the light stays on all night". The hub re-sends at half the TTL so a single dropped message never causes a visible flicker.

**Restart vs reboot.** `restart_service` is the one to reach for: the publisher exits, systemd brings it back in ~2 s, and the V4L2 device is cleanly reopened. That fixes nearly every camera problem. `reboot` takes ~40 s and needs the scoped sudoers rule the installer writes. The unit uses `Restart=always` (not `on-failure`) precisely so a clean exit is restarted, and `NoNewPrivileges=false` because it otherwise blocks `sudo` outright.

## 9. MagicMirror² module (optional)

`MMM-SecurityLuxDisplay` is a **pure browser-side display client** — it has no `node_helper`, no embedded server, no npm dependencies. It just polls the hub's HTTP API and renders an `<img>` for the live MJPEG.

Skip this entire section if you don't run MagicMirror; the hub's built-in dashboard at `http://<hub>:5000/` is fully usable on its own.

The module's source of truth lives in this repo at `mm_module/MMM-SecurityLuxDisplay/` and is symlinked into MagicMirror via `mm_module/install.sh`. One `MMM-SecurityLuxDisplay` config entry per camera you want to display.

### Configuration (example `config.js` entry)
```js
{
  module: "MMM-SecurityLuxDisplay",
  position: "bottom_right",
  config: {
    hubUrl: "http://meer.local:5000",   // any reachable SecurityLuxHub
    camId: "front",                     // matches the camera_node's `camera.id`
    pollMs: 500,                        // status-poll cadence; matches default detector tick rate
    hideWhenOff: true,
    showToggleButton: false,
    showStatusBar: true,
    width: "320px",
    title: "Security Lux"
  }
}
```

### Behavior
- When feed is on: shows the live MJPEG stream from `${hubUrl}/cam/<camId>/stream.mjpg`.
- When the camera is offline (no WS connection from a camera_node to the hub): shows a `Camera "<id>" offline` placeholder.
- When the feed is off: either hides the module or shows a "Camera off" placeholder depending on `hideWhenOff`.
- Status: polled from `${hubUrl}/cam/<camId>/status` every `pollMs` (default 500 ms). When the hub reports a fresh `current_detection` a green pulsing chip + bbox overlay appear.
- Toggle button (when `showToggleButton: true`): `fetch()`es `POST ${hubUrl}/cam/<camId>/toggle`.
- Listens for MM2 notifications: `SECURITY_LUX_TOGGLE`, `SECURITY_LUX_ON`, `SECURITY_LUX_OFF`.

### Module file layout
```
MMM-SecurityLuxDisplay/
  MMM-SecurityLuxDisplay.js        # browser module: poll + render
  MMM-SecurityLuxDisplay.css       # styling
  README.md
```

### Tech stack
- **Lives entirely in the browser.** No `node_helper.js`, no npm install.
- **Networking:** the standard `fetch()` API for HTTP poll + toggle. The MJPEG stream is a vanilla `<img src=…>` pointed at the hub.
- **No MagicMirror notifications between browser and helper.** With no helper, the module talks directly to the hub.

## 10. Future roadmap

The hub-and-spoke v0.2 design exists explicitly to support these phases without re-plumbing the camera side.

### Phase 2 — multi-camera + recording (shipped, M8/M12/M13)
- Multiple cameras route by `cam_id`; the dashboard picks single / grid / detail automatically.
- Clips are recorded by the hub with pre-roll and post-roll around each detection.
- Retention is a three-limit policy in `hub/src/storage.js` — age, clip budget, and a free-space floor.

### Phase 3 — recognition & event log

#### Phase 3a — person detection + clip recording (shipped, M9a)
- `hub/src/detector.js` + `detector.worker.js` run YOLOv8n-int8 inference on the buffered frames in a `worker_threads` Worker (~2 fps, ~150 ms per inference on Pi 4 8 GB).
- A per-camera state machine (`hub/src/session.js`) groups consecutive person detections into "sessions": idle → active on first detection, end on a 1.5 s grace window without a person.
- Each session writes a row to a local SQLite event log (`~/.securityluxhub/events.db`) and records a video clip (`~/Videos/SecurityLux/<YYYY-MM-DD>/<HH-MM-SS>_<cam_id>_person.mkv`) via an `ffmpeg` child process.
- Hub HTTP endpoints: `GET /cam/<id>/events`, `GET /events/<id>`, `GET /events/<id>/clip.<ext>` (with `Range` support); a self-contained dashboard at `GET /` lists events with inline `<video>` playback; `GET/POST /detection` toggles detection at runtime.
- Cameras stay oblivious — all ML stays on the hub.

#### Phase 3c — zones, tracking, descriptions (shipped, M14)
- Detections are threaded into tracks and classified by behaviour, which is what separates "walked past" from "stood at the door for four minutes".
- Named zones drawn in the browser give events a *place*, and `ignore` zones kill recurring false positives at the source.
- Descriptions are composed locally from those facts. Deliberately not a language model: the inputs are things the hub knows for certain, and in a security log an invented detail is worse than a plain sentence.

#### Phase 3b — face recognition (scaffolded, M9b)
- Identify *who* the person is, not just *that* a person is there.
- Emits richer events like `unknown_face`, `known_face:jared` keyed off enrolled profiles.
- **Remaining work:** publish SCRFD-500m (~2.5 MB) and MobileFaceNet (~4 MB) ONNX models to the `models-v1` GitHub release, then implement `Recognizer._embed()` in `hub/src/recognize.js` — crop the person box, detect the face, align to 112×112 using the landmarks, embed, L2-normalize. Matching, storage, and enrollment already exist and are tested. Run it in the existing detector worker at ≤1 fps on frames that already have a person, which keeps the added cost near 15% of one Pi 4 core.
- Door / package / animal classes follow the same hub-side worker pattern.

### Phase 4 — profiles & clearances (shipped except recognition, M9b)
- Profiles, clearance levels 0-3, notes, and face samples are stored and editable in the web UI.
- Faces enroll either by upload or, far more usefully, in one click from an event thumbnail — the system has already captured the person at the angle and lighting the camera actually sees them in.
- Auto-created anonymous profiles for recurring unknown faces are implemented in `Recognizer.noteUnknown()` and activate with recognition.
- Clearance drives nothing yet; it exists so Phase 5 has something to key off.

### Phase 5 — home automation integrations
- **Shipped:** an outbound event webhook (`events.webhookUrl`). Deliberately generic — ~20 lines, and it lets you drive ntfy, Home Assistant, or a shell script without the hub knowing anything about any of them.
- **Shipped:** the mirror shows the last event's description and relative timestamp.
- Auto-unlock deadbolt for known profiles with sufficient clearance (hardware TBD — Z-Wave or Zigbee bolt). Explicitly out of scope for now.
- Optional: first-class push notifications when unknown faces arrive.

### Phase 6 — candidates, not commitments
- **Optional shared-secret auth.** "Trusted LAN, no auth" is defensible today, but the moment there's a port-forward or a VPN guest, every camera is an open MJPEG endpoint. A single opt-in token covering the HTTP surface and the WS hello would be cheap insurance and cost nothing while off.
- Package / vehicle / animal detection classes.
- Timeline scrubbing across a whole day rather than discrete clips.

### Design principle for all future work
**Keep the camera units dumb. Put intelligence on the hub.** Cameras capture and stream. The hub host — always-on, mains-powered — runs recognition, logging, rules, and integrations. This keeps camera units cheap, low-power, easy to replicate, and safe to run on PiSugar battery.

## 11. Pi setup instructions (camera unit)

These steps turn a blank microSD card into a working SecurityLux setup.

### 11.1 Flash the OS
1. Download the Raspberry Pi Imager (https://www.raspberrypi.com/software/).
2. Choose **Raspberry Pi OS Lite (64-bit)** — no desktop.
3. Before writing, open advanced settings and set:
   - Hostname: `camera-node`
   - Username + password (memorable; you'll SSH as this user)
   - WiFi SSID and password (2.4 GHz network)
   - Locale / keyboard
   - Enable SSH
4. Flash the microSD, insert into the Pi Zero 2 W, attach the USB webcam via OTG adapter, power on.

### 11.2 First login and base update
```bash
ssh <user>@securitylux-cam.local
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

### 11.5 Clone the repo and install Python deps
```bash
git clone <your-repo-url> ~/SecurityLux
cd ~/SecurityLux/camera_node
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

### 11.6 Configure the hub URL
Copy the example config and point at the Mirror Pi:
```bash
sudo mkdir -p /etc/camera-node
sudo cp config.example.yml /etc/camera-node/config.yml
sudoedit /etc/camera-node/config.yml   # set hub.url and camera.id
```
Default `hub.url` is `ws://meer.local:5000` and default `camera.id` is `front`. Adjust if you renamed the Mirror Pi or you're adding a second camera.

### 11.7 Install the systemd unit
A `camera-node.service` file ships in the repo. Install and enable:
```bash
sudo cp deploy/camera-node.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now camera-node
sudo systemctl status camera-node
journalctl -fu camera-node   # should log "Connecting to hub at ws://meer.local:5000/cam/front"
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

### 11.9 (Optional) Install the MagicMirror display module
Skip if you don't run MagicMirror. On the Mirror Pi:
```bash
cd ~/SecurityLux
./mm_module/install.sh                  # auto-detects ~/MagicMirror
# or, if MM lives elsewhere:
./mm_module/install.sh /path/to/MagicMirror
```
The script just symlinks `<MagicMirror>/modules/MMM-SecurityLuxDisplay` into this repo. **No `npm install`** — the module is pure browser JS and talks to the hub over `fetch()`. Then add the `MMM-SecurityLuxDisplay` entry shown in Section 9 to `~/MagicMirror/config/config.js` and restart MagicMirror.

### 11.10 Install the hub
Pick whichever Linux box will be the hub (Node.js 18+ required):
```bash
git clone <your-repo-url> ~/SecurityLux
cd ~/SecurityLux
./hub/install.sh
```
Installs npm deps (`onnxruntime-node`, `sharp`, `better-sqlite3`, `ws`, `js-yaml`) inside `hub/`, bootstraps `/etc/security-lux-hub/config.yml`, and registers `security-lux-hub.service`. Detection is off by default; flip it on in the config or via `POST /detection` at runtime.

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

### Hub-side dependencies (SecurityLuxHub host)
Listed in `hub/package.json` and installed via `./hub/install.sh` (which runs `npm install --omit=dev` inside `hub/`):

```
ws@^8                  - WebSocket server for camera_node connections
better-sqlite3@^11     - synchronous SQLite for the events log
onnxruntime-node@^1    - ONNX Runtime; powers YOLOv8n inference inside the worker
sharp@^0.33            - JPEG decode + resize on the fast path into the worker
js-yaml@^4             - hub config file parser
```

Plus `ffmpeg` as a system binary (`apt install ffmpeg` on Debian/Ubuntu/Pi OS) for clip recording. Without ffmpeg, detection still runs and the events row is written; only the clip is skipped.

No new hub dependencies were added for v0.4 — zones, tracking, descriptions, storage policy, and the settings layer are all plain JavaScript, and the face-sample pipeline reuses `sharp`.

### Optional camera-side dependencies (`requirements-led.txt`)

```
adafruit-circuitpython-neopixel-spi==1.*
adafruit-blinka==8.*
```

Kept out of `requirements.txt` on purpose: `adafruit-blinka` binds to Raspberry Pi hardware at install time and fails on a dev laptop, which would break `pip install -r requirements.txt` for anyone not on a Pi. `camera_node/led.py` imports both behind a guard, so a camera without them (or without a strip, or without SPI enabled) keeps streaming exactly as before and logs the reason once.

## 13. Implementation plan (milestones)

| Milestone | Status | What "done" looks like |
|---|---|---|
| **M1 — Hardware bring-up** | done (v0.1) | Pi Zero 2 W flashed, on WiFi, reachable at `securitylux-cam.local`. USB webcam detected. PiSugar reports battery over its socket. |
| **M2 — Capture + stream** | done (v0.1) | Python service opens the camera and produces JPEGs end to end. |
| **M3 — Viewer + toggle** | done (v0.1) | Toggle works, status reports PiSugar battery. |
| **M4 — Productionize** | done (v0.1) | Config file, `systemd` unit, auto-restart on crash, device released when off. |
| **M5 — MagicMirror module** | done (v0.1) | `MMM-SecurityLuxDisplay` rendered the camera's stream and toggled it. |
| **M6 — Hardening** | done (v0.1) | Logging, repo README, `requirements.txt` pinned. |
| **M7 — Hub inversion (v0.2)** | done | Mirror Pi ran the hub on `:5000`. Camera became a thin async WebSocket publisher; no inbound port. |
| **M8 — Multi-camera + recording** | done | Hub routes by `cam_id`; dashboard has single / grid / detail layouts, verified with two cameras. |
| **M9a — Person detection + clip recording** | done | Hub-side `worker_threads` detector runs YOLOv8n-int8 on buffered frames; per-event clips land in `~/Videos/SecurityLux/`; events queryable at `GET /cam/<id>/events`; dashboard plays them inline. |
| **M9b — Face recognition** | scaffolded | Profiles, clearances, enrollment, sample storage, and the matching maths are all implemented and tested. Blocked only on publishing SCRFD + MobileFaceNet ONNX models to the `models-v1` release and implementing `Recognizer._embed()`. The system is fully functional with it off, which is the default. |
| **M10 — Hub split (v0.3)** | done | Hub extracted from MagicMirror into a standalone Node service (`hub/`). MagicMirror module became an optional pure-browser display client (`MMM-SecurityLuxDisplay`). Component naming standardized on `SecurityLuxHub` / `camera_node`. |
| **M11 — Stream reliability** | done | `StreamKeeper` replaces the blind refresh timer that was blanking the feed after ~5 minutes. Reconnects on evidence: error events, page visibility, bfcache restore, and a canvas-based stall detector that catches a wedged decoder (which fires no events at all). Shared verbatim between the dashboard and the mirror module, with a test that fails if the copies drift. |
| **M12 — Event capture (v0.4)** | done | Per-camera frame ring buffer; clips open with pre-roll and continue through post-roll; thumbnails from mid-pre-roll; h264/mp4 default (~13× smaller than MJPEG and playable everywhere). |
| **M13 — Storage policy** | done | `retentionDays` + `maxTotalGB` + `minFreeGB` enforced every 15 min and after every clip. Budget reclaims video while keeping event rows; the floor pauses recording rather than wedging the hub. Storage page with usage, per-camera breakdown, and projected runway. |
| **M14 — Zones, tracking, descriptions** | done | Zone editor over a live snapshot; centroid tracker; behaviour classification; local template describer with sunrise/sunset-aware wording. Descriptions regenerable over history after a zone rename. |
| **M15 — Door light** | done | SPI-driven NeoPixel on the camera Pi with five escalating patterns, TTL-based fail-dark, software brightness cap, and a wiring-test button. Degrades to a no-op with no hardware. |
| **M16 — Remote camera control** | done | Restart and reboot from the UI, scoped sudoers rule, uptime + reconnect count surfaced per camera. |
| **M17 — Browser-editable settings** | done | Schema-driven settings with per-camera overrides; API and UI generated from one declaration. |

## 14. Risks & open questions

- **Thermal/CPU on Pi Zero 2 W:** sustained capture + JPEG encode + WS send may push CPU high. Mitigation: cap at 15 fps and 640×480; monitor with `vcgencmd measure_temp`.
- **USB power:** USB webcams can draw real current. If the Pi browns out, we'll need a powered USB hub or a camera with lower draw.
- **WiFi range:** the Zero 2 W radio is weaker than the Pi 4's. If the doorway has poor signal, a USB WiFi adapter or repositioning may be needed.
- **No auth:** acceptable for a trusted LAN. Before any non-LAN exposure we'd add a shared secret in the WS hello and TLS termination on the hub.
- **PiSugar longevity:** battery capacity degrades. Plan a yearly health check (the camera reports `battery_pct` to the hub on every status tick — easy to log over time).
- **Hub is a single point of failure:** if the hub host is down, no cameras are visible. Acceptable for the home setup but worth noting before scaling beyond it.
- **Native deps + Node version drift:** `better-sqlite3`, `sharp`, and `onnxruntime-node` ship native bindings that must be built against the Node version that runs the hub. If the user upgrades Node out from under the install, the hub fails to load these deps; `./hub/install.sh` re-runs `npm install` against the current Node which fixes it. The dashboard surfaces this specific failure with that instruction rather than a generic error.
- **SD card wear:** continuous video writes will eventually kill a cheap card. The storage budget bounds total written volume, and h264 cuts the write rate ~13× versus MJPEG, but a hub recording heavily should ideally write clips to an external SSD (`storage.clipsRoot`) with only the database on the card.
- **SPI clock drift and WS2812 timing:** the door light is driven over SPI, whose clock tracks the core clock. Without `core_freq_min=500` in `/boot/firmware/config.txt`, CPU frequency scaling can corrupt the bit timing and produce flickering or wrong colours. Documented in the camera README and checked by the installer.
- **LED power draw:** eight LEDs at full white draw ~480 mA, more than the Pi Zero's 5V rail should supply while a PiSugar is charging. Brightness is capped at 40% by default and enforced on the camera as well as the hub, so a bad hub command can't overdraw the rail.
- **Clock correctness:** a Pi with no RTC boots at the epoch and stays there until NTP lands. Events written in that window sort before everything else forever and are effectively unfindable, so the hub refuses to write events until the clock looks sane and says so in the UI.
- **Browser connection limits:** each live MJPEG stream holds one of the browser's ~6 connections per origin. Beyond about six simultaneously-visible cameras, streams will start failing to open; the fix is to switch grid tiles to polled `snapshot.jpg` rather than continuous streams.
- **Descriptions are only as good as the zone labels:** with no zones drawn the describer degrades to "Someone was at the front door camera for 12 seconds", which is correct but not the interesting version. This is a documentation and onboarding problem more than a technical one.

## 15. Glossary

- **MJPEG** — Motion JPEG. A video format where each frame is a standalone JPEG. Browsers can render a continuous MJPEG HTTP response directly in an `<img>` tag.
- **UVC** — USB Video Class. A standard that lets most USB webcams work on Linux (via the `uvcvideo` kernel driver) without extra drivers.
- **V4L2** — Video4Linux2. The kernel API for interacting with video capture devices on Linux.
- **MM2** — MagicMirror², the smart-mirror platform we're integrating with.
- **PiSugar** — third-party UPS/battery HAT for Raspberry Pi, exposes state over a local socket.
- **mDNS** — multicast DNS, lets us reach Pis at `meer.local` / `securitylux-cam.local` without static IPs.
- **Hub** (a.k.a. **SecurityLuxHub**) — the always-on Linux host running `hub/src/hub.js`. Owns the desired state and the latest-frame buffer per camera, plus detection + the events store + the dashboard.
- **Publisher** — the Python process on a camera Pi that maintains the WebSocket to the hub.
- **`cam_id`** — string identifier a camera registers under (e.g. `front`, `porch`). Keys both the WS endpoint and all HTTP routes.
