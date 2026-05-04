# LuxSecurityCamera

A self-hosted, LAN-only home security camera system. **No cloud, no
accounts, no subscriptions.** Cameras stream to a hub on your network; the
hub buffers frames, runs optional on-host person detection, records
per-event video clips, and serves a tiny dashboard so you can review
everything from any device on the LAN.

It's three independent components — pick the pieces you want:

- **`hub/`** — the standalone Node.js server. Camera nodes connect to it,
  detection runs inside it, the dashboard is served from it. Runs on any
  Linux host with Node 18+: a spare Raspberry Pi, a desktop, a NUC, or
  alongside MagicMirror on a mirror Pi.
- **`camera_node/`** — a thin Python publisher for low-power Raspberry Pis
  (designed for the Pi Zero 2 W). Captures frames from a USB webcam,
  pushes them to the hub over a single outbound WebSocket, accepts
  on/off commands back. One per camera.
- **`mm_module/MMM-LuxSecurityDisplay/`** — *optional* MagicMirror² module
  that displays one camera's live feed on your mirror. Pure browser-side
  client; just renders what the hub already exposes over HTTP.

See [`PRD.md`](PRD.md) for the full architecture and roadmap.

## Repo layout

```
LuxSecurityCamera/
├── hub/                                  # standalone hub server (Node.js)
│   ├── src/                              #   server.js, detector.*, store.js, recorder.js, …
│   ├── web/index.html                    #   self-contained dashboard
│   ├── tests/                            #   node --test
│   ├── config.example.yml
│   └── install.sh
│
├── camera_node/                          # camera publisher (Python on the Pi)
│   ├── camera_node/                      #   the package (run via `python -m camera_node`)
│   ├── tests/                            #   pytest
│   ├── config.example.yml
│   ├── apt-requirements.txt
│   ├── requirements.txt
│   └── install.sh
│
└── mm_module/                            # optional MagicMirror display
    ├── MMM-LuxSecurityDisplay/
    └── install.sh
```

## Quick start

Each component has its own one-shot installer. Run only the ones you need.

### 1. Hub (one of these)

On whichever box will be the hub — typically a Raspberry Pi 4/5, but any
Linux host with Node 18+ works:

```bash
git clone https://github.com/JaredLodwick/DoorCamera.git ~/LuxSecurityCamera
cd ~/LuxSecurityCamera
./hub/install.sh
```

Installs npm deps (onnxruntime-node, sharp, better-sqlite3, ws, js-yaml),
bootstraps `/etc/lux-security-hub/config.yml`, and registers a systemd
unit (`lux-security-hub.service`) that starts on boot and auto-restarts
on crash. Warns if `ffmpeg` is missing (recording silently skips without
it; detection still runs).

### 2. Camera node (one per camera)

On each Raspberry Pi attached to a USB webcam:

```bash
git clone https://github.com/JaredLodwick/DoorCamera.git ~/LuxSecurityCamera
cd ~/LuxSecurityCamera
./camera_node/install.sh
```

Installs apt + pip deps, adds the user to the `video` group, bootstraps
`/etc/camera-node/config.yml` (default hub: `ws://meer.local:5000`,
`cam_id: front` — edit if needed), registers `camera-node.service`.

### 3. (Optional) MagicMirror display

If you also want the feed on a MagicMirror:

```bash
git clone https://github.com/JaredLodwick/DoorCamera.git ~/LuxSecurityCamera
cd ~/LuxSecurityCamera
./mm_module/install.sh
```

Symlink-only — no npm install. Then add an `MMM-LuxSecurityDisplay` entry
to `~/MagicMirror/config/config.js` (see
[`mm_module/MMM-LuxSecurityDisplay/README.md`](mm_module/MMM-LuxSecurityDisplay/README.md))
and restart MagicMirror.

### Verify

From any device on the LAN:

```bash
curl http://<hub-host>:5000/healthz       # → ok
curl http://<hub-host>:5000/cams          # JSON list of registered cameras
```

Then open `http://<hub-host>:5000/` for the events dashboard. Walk past
the camera and you should see a new event appear with a clip you can play
inline.

All three installers are **idempotent** — re-run them after `git pull` to
upgrade. The installers leave existing config files alone so your
customizations survive.

## Migrating from the embedded-hub setup

If you set up an earlier version where the hub lived inside MagicMirror's
`MMM-DoorCam` module, see
[`INSTALLATION.md`](INSTALLATION.md#migrating-from-the-embedded-hub) for
a short migration walk-through. The wire protocol is unchanged, so your
camera_node config keeps working — only the hub moved.
