# MMM-DoorCam

A MagicMirror² module that **also runs the camera hub**. The MagicMirror Pi
is the always-on hub for the smart-home setup; door cameras (and other
low-power devices) connect *out* to it over WebSocket and stream JPEG frames
in. The browser-side module renders one camera's MJPEG feed and exposes a
toggle that the hub forwards down to the camera.

This inverts the older design where each camera ran its own Flask server
that the mirror polled. Now the camera is a thin publisher and the mirror
buffers the latest frame for any number of consumers (the on-mirror UI,
detector workers, recorders, etc.).

## What's in the module

```
MMM-DoorCam/
  MMM-DoorCam.js     # browser-side UI: status, MJPEG <img>, toggle button
  MMM-DoorCam.css
  node_helper.js     # the hub: HTTP+WS server on :5000
  detector.js        # main-thread façade for the YOLO worker
  detector.worker.js # ONNX Runtime + sharp; runs YOLOv8n-int8 inference
  session.js         # per-cam state machine: idle ↔ active
  recorder.js        # ffmpeg child process; writes per-event clips
  store.js           # better-sqlite3 wrapper for the event log
  store.test.js
  session.test.js
  README.md
```

The hub listens on its own port (default `5000`), separate from MagicMirror's
own web server, so the camera traffic isn't subject to MM's `ipWhitelist`.

## Hub endpoints

WebSocket (camera publishers connect here):

- `ws://meer.local:5000/cam/<cam_id>` — binary frames + JSON status messages.
  Hub sends `{"type":"set_state","state":"on"|"off"}` down to the camera.

HTTP (browsers, scripts, other modules):

| Method | Path                          | Purpose |
|--------|-------------------------------|---------|
| GET    | `/healthz`                    | Plain `ok`. |
| GET    | `/cams`                       | JSON list of registered cameras + last-known status. |
| GET    | `/cam/<id>/status`            | Status for one camera. |
| GET    | `/cam/<id>/stream.mjpg`       | Multipart MJPEG stream of the buffered frames. |
| POST   | `/cam/<id>/toggle`            | Body `{"state":"on"\|"off"}` to set, no body to flip. |
| GET    | `/cam/<id>/events`            | Detection events list. Query: `since` (ms epoch), `limit` (default 50, cap 200). |
| GET    | `/events/<id>`                | Single event JSON. |
| GET    | `/events/<id>/clip.mkv`       | Streams the recorded clip with `Range` support. |

CORS is wide-open so any LAN page can drive the hub.

> **Auth caveat.** Like every other endpoint, the new `/events` and `/clip.mkv`
> routes have no authentication and CORS is wide-open. The clips contain
> recordings of people at your door — keep this on a trusted LAN only, exactly
> as the rest of the system expects (`PRD.md` §14).

## Configuration

Add an entry to `~/MagicMirror/config/config.js`:

```js
{
  module: "MMM-DoorCam",
  position: "bottom_right",
  config: {
    camId: "front",                       // matches the camera's `camera.id`
    hubUrl: "http://meer.local:5000",     // base URL the browser uses for the MJPEG <img>
    hubPort: 5000,                        // port the node_helper binds to
    hideWhenOff: false,
    showToggleButton: true,
    showStatusBar: true,
    width: "320px",
    title: "Door Cam"
  }
}
```

Cameras default to `on` as soon as they connect to the hub. To force one off
on startup, hit the toggle endpoint from a startup script or click the
button. There's no `startEnabled` flag.

| Option            | Default                       | Notes |
|-------------------|-------------------------------|-------|
| `camId`           | `front`                       | Identifier the camera publishes under. |
| `hubUrl`          | `http://meer.local:5000`      | Base URL the browser fetches `/stream.mjpg` from. |
| `hubPort`         | `5000`                        | TCP port the helper binds (HTTP + WS). |
| `hideWhenOff`     | `true`                        | Hide the module entirely when the feed is off. |
| `showToggleButton`| `true`                        | Render the Turn ON / Turn OFF button. |
| `showStatusBar`   | `true`                        | Render the small fps / resolution / battery line. |
| `width`           | `320px`                       | Width of the module. |
| `title`           | `Door Cam`                    | Header text. Empty string hides it. |

If you stack multiple `MMM-DoorCam` instances on one mirror (one per camera),
they all share the same hub — only the first instance's `hubPort` matters.

## Install

```bash
cd ~/MagicMirror/modules/MMM-DoorCam
# `ws` is already in MagicMirror's node_modules; nothing to install.
```

Then add the module entry to `config.js` and restart MagicMirror.

## Notifications

The browser module accepts these MM2 notifications:

- `DOORCAM_TOGGLE` — flip the feed.
- `DOORCAM_ON` — force the feed on.
- `DOORCAM_OFF` — force the feed off.

## Camera side

See the `DoorCamera` repo's `pi_client/` — the Pi runs a small Python
publisher that connects to `ws://meer.local:5000/cam/<id>` and streams
frames + battery status.

## Person detection & event recording

The hub can run real-time person detection on the buffered frames it already
receives — entirely on the MagicMirror Pi, with the camera Pi staying dumb.
Each "person session" (a person enters frame → stays → leaves) becomes:

1. A row in a SQLite event log (`~/.mm-doorcam/events.db`).
2. A video clip on disk at
   `~/Videos/SecurityCamera/<YYYY-MM-DD>/<HH-MM-SS>_<cam_id>_person.mkv`.

While a person is in frame, the on-mirror module shows a green
bounding-box overlay around the detection and a "Person detected" chip
in the bottom-left status row.

### Enable it

Detection is **off by default**. Add `detection.enabled: true` to the module's
`config.js` entry:

```js
{
  module: "MMM-DoorCam",
  position: "bottom_right",
  config: {
    camId: "front",
    detection: { enabled: true }
  }
}
```

Then run `./mm_module/install.sh` once on the hub Pi to install the new
hub-side npm deps (`onnxruntime-node`, `sharp`, `better-sqlite3`) into
MagicMirror's bundle, and make sure `ffmpeg` is on `PATH`
(`sudo apt-get install -y ffmpeg`). Restart MagicMirror.

The detector lazy-downloads its ONNX model on first start to
`~/.mm-doorcam/models/yolov8n-int8.onnx`. Without internet on the hub at
first boot, detection logs a warning and stays disabled — the rest of the
hub keeps streaming. It retries on the next start.

### Configuration knobs

All optional; defaults shown. Override any subset under the same module
config.

```js
detection: {
  enabled: false,
  fps: 2,                     // detector ticks per second
  confidence: 0.45,           // min person-class score to count
  classes: ["person"],
  modelUrl: "https://github.com/JaredLodwick/DoorCamera/releases/download/models-v1/yolov8n-int8.onnx",
  modelSha256: ""             // SHA-256 of the ONNX file; empty = skip check
},
recording: {
  codec: "mkv",               // "mkv" (stream-copy, ~zero CPU) | "h264" (libx264 ultrafast)
  fps: 15,                    // matches the camera's output
  minClipSeconds: 2,          // sub-2s sessions are dropped (false-positive filter)
  maxClipSeconds: 300,        // cap a single clip's length; new clip starts after
  graceMs: 1500,              // grace window after the last person frame before ending
  retentionDays: 14           // daily sweep deletes events + clips older than this
},
clipsRoot: "~/Videos/SecurityCamera",
dbPath: "~/.mm-doorcam/events.db"
```

### Tradeoffs at a glance

- **MKV stream-copy** is the default codec because it's zero-CPU, tail-readable
  if MagicMirror crashes mid-event, and plays in browsers via `<video>`. Files
  are 5-10× larger than re-encoded H.264. Switch to `codec: "h264"` if disk is
  tight and CPU isn't.
- **Detection runs in a worker thread.** Inference takes ~150 ms on a Pi 4
  with the int8 model, so keeping it off the main thread avoids visible jank
  in the live MJPEG stream.
- **Sessions, not frames.** A person who lingers for 15 s produces one clip
  (up to `maxClipSeconds`), not 15. Single-frame false positives are filtered
  by the `minClipSeconds` floor.

### Querying events

```bash
# Recent events for the front camera
curl http://meer.local:5000/cam/front/events | python3 -m json.tool

# Single event
curl http://meer.local:5000/events/42 | python3 -m json.tool

# Download / play the clip
curl -o /tmp/clip.mkv http://meer.local:5000/events/42/clip.mkv
mpv /tmp/clip.mkv
```

The HTML5 `<video>` tag works too — the clip endpoint supports `Range`
requests, so seeking and partial loads behave normally.

### Tests

```bash
cd mm_module/MMM-DoorCam
node --test session.test.js   # state machine; no deps required
node --test store.test.js     # requires better-sqlite3 (installed by install.sh)
```
