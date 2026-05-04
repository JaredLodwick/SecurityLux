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
- A desktop / NUC / x86 box on the same LAN.

## Install (Linux, systemd)

```bash
git clone https://github.com/JaredLodwick/DoorCamera.git ~/DoorCamera
cd ~/DoorCamera
./hub/install.sh
```

The installer:

1. Verifies Node.js >= 18, npm, and systemd are present (warns if `ffmpeg`
   is missing — detection still works, recording silently skips).
2. `npm install`s the hub's deps (`onnxruntime-node`, `sharp`,
   `better-sqlite3`, `ws`, `js-yaml`).
3. Bootstraps `/etc/lux-security-hub/config.yml` from `config.example.yml`
   (only if absent — re-runs preserve customization).
4. Generates `/etc/systemd/system/lux-security-hub.service` with your user
   + the install path templated in. `Restart=on-failure`, comes back on
   reboot.
5. Enables, starts, and verifies the service. Prints a summary of useful
   commands at the end.

It is idempotent: re-run after `git pull` to upgrade.

## Run without systemd (dev)

```bash
cd hub
npm install
node src/hub.js                                   # uses /etc/lux-security-hub/config.yml or built-in defaults
LUXHUB_CONFIG=/tmp/luxhub.yml node src/hub.js     # or point at any YAML
node src/hub.js /path/to/config.yml               # or pass it as a CLI arg
```

The hub binds to `0.0.0.0:5000` by default. Open `http://<host>:5000/` for
the events dashboard.

## HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/`                                | The events dashboard (single self-contained HTML page). |
| `GET`  | `/healthz`                         | Plain `ok`. |
| `GET`  | `/cams`                            | JSON list of registered cameras + last-known status. |
| `GET`  | `/cam/<id>/status`                 | Status for one camera (state, connected, fps, battery, current_detection, …). |
| `GET`  | `/cam/<id>/stream.mjpg`            | Multipart MJPEG stream of the buffered frames. |
| `POST` | `/cam/<id>/toggle`                 | Body `{"state":"on"\|"off"}` to set; no body to flip. |
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
