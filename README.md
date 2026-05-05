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

One installer, three components. On each device, clone the repo and run
the installer once — it asks which component to install, sets it up, and
deletes the other two component directories so the device only carries
what it actually runs.

```bash
git clone https://github.com/JaredLodwick/DoorCamera.git ~/LuxSecurityCamera
cd ~/LuxSecurityCamera
./install.sh
```

Repeat on each device with the appropriate choice:

- **On the hub host** — a spare Pi 4+, NUC, Linux box, **or a Mac** (Apple Silicon or Intel). Anything with Node 18+ works. → choose **1) hub**. Windows users: see [`hub/README.md`](hub/README.md#install--windows) for the manual install path.
- **On each camera Pi** (a Pi Zero 2 W with a USB webcam) → choose **2) camera**. You'll be asked for the hub's URL and a name for this camera.
- **On a MagicMirror Pi** (optional, only if you want the feed on your mirror) → choose **3) viewer**. You'll be asked for your MagicMirror install path and the hub URL; at the end the installer prints the exact `config.js` snippet to paste in.

Want to run two components on the same physical Pi (e.g. hub + viewer on a single MagicMirror Pi)? Clone the repo into a second directory and run the installer again with the other choice.

### Verify

From any device on the LAN:

```bash
curl http://<hub-host>:5000/healthz       # → ok
curl http://<hub-host>:5000/cams          # JSON list of registered cameras
```

Then open `http://<hub-host>:5000/` for the events dashboard. Walk past
the camera and you should see a new event appear with a clip you can play
inline.

### Upgrading and re-installing

Each component upgrades by pulling and re-running its own installer:

```bash
cd ~/LuxSecurityCamera && git pull && ./hub/install.sh           # on the hub host
cd ~/LuxSecurityCamera && git pull && ./camera_node/install.sh   # on a camera Pi
cd ~/LuxSecurityCamera && git pull && ./mm_module/install.sh     # on the MagicMirror Pi
```

(After `./install.sh` cleanup, only the surviving component's installer is present — that's the right one to use for upgrades on that box.) All three are idempotent and leave existing config files alone.

**Hub acting up?** Re-running `./hub/install.sh` on the hub host is the recommended fix for almost any hub problem — it rewrites the systemd unit / launchd LaunchAgent and restarts the service while preserving your config, events DB, and recorded clips. Detection-aware: the installer probes for an existing hub on this machine and on the network and walks you through the right next step (re-install vs. migrate vs. recover) before touching anything. See [`INSTALLATION.md` § Re-installing / migrating the hub](INSTALLATION.md#re-installing--migrating-the-hub) for the full walkthrough.

## Migrating from the embedded-hub setup

If you set up an earlier version where the hub lived inside MagicMirror's
`MMM-DoorCam` module, see
[`INSTALLATION.md`](INSTALLATION.md#migrating-from-the-embedded-hub) for
a short migration walk-through. The wire protocol is unchanged, so your
camera_node config keeps working — only the hub moved.
