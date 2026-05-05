# LuxSecurityCamera

A self-hosted, LAN-only home security camera system. **No cloud, no
accounts, no subscriptions.** Cameras stream to a hub on your network; the
hub buffers frames, optionally runs on-host person detection, records
per-event video clips, and serves a dashboard you can hit from any device
on your LAN.

---

## Get it running (3 steps)

One installer, three components. On each device, clone the repo and run
the installer — it asks which component to set up, configures it, and
deletes the other two component directories so the device only carries
what it actually runs.

### Step 1 — install the hub (one per home)

On the box that will be the hub. Anything with **Node.js 18+**: a spare
Raspberry Pi 4+ / Pi 5, a Linux desktop, a NUC, or **a Mac**. (Windows is
supported via a manual recipe — see [`hub/README.md`](hub/README.md#install--windows).)

```bash
git clone https://github.com/JaredLodwick/DoorCamera.git ~/LuxSecurityCamera
cd ~/LuxSecurityCamera
./install.sh             # choose 1) hub
```

When it finishes, open `http://<hub-host>:5000/` from any device on your
LAN — you'll see an empty dashboard waiting for cameras.

### Step 2 — install a camera node (one per camera)

On each Raspberry Pi attached to a USB webcam (Pi Zero 2 W is the target
form factor; any Linux Pi works):

```bash
git clone https://github.com/JaredLodwick/DoorCamera.git ~/LuxSecurityCamera
cd ~/LuxSecurityCamera
./install.sh             # choose 2) camera
```

You'll be asked for the hub's URL (default `ws://meer.local:5000`) and a
short identifier for this camera (`front`, `porch`, `garage`, …). The
camera registers with the hub immediately. Refresh the dashboard and it'll
show up.

### Step 3 — *(optional)* install the MagicMirror display

If you have a MagicMirror² mirror and want a camera feed on it, run the
installer there too:

```bash
cd ~/LuxSecurityCamera
./install.sh             # choose 3) viewer
```

You'll be asked for your MagicMirror install path and the hub URL. The
installer prints the exact `config.js` snippet to paste in.

You don't need MagicMirror — the hub's built-in dashboard is the primary
UI for the system.

> **Want both hub and viewer on the same Pi?** Just re-run `./install.sh`
> on that machine and pick the other component. The installer leaves
> both the `hub/` and `mm_module/` packages on disk for exactly this
> case — only `camera_node/` gets removed (it never runs on the same
> machine as the hub or viewer). No re-cloning needed.

---

## How it works

```
+-------------------+       single outbound       +--------------------+
| camera_node       | ====== WebSocket ========>  |  LuxSecurityHub    |
| (Pi Zero 2 W)     |  binary JPEG frames + JSON  |  (any Linux/macOS) |
| Python publisher  | <==== set_state on/off ==== |  HTTP+WS on :5000  |
+-------------------+                             +--------------------+
                                                          ^
                                                          | HTTP
                       +----------------------------------+----------------+
                       |               |                  |                |
                  any browser        curl /           MagicMirror      future
                  on the LAN         scripts          module           clients
                  (dashboard)                         (optional)
```

- The **hub is the only inbound listener** in the system. It buffers the
  latest JPEG per camera, runs detection in a worker thread, records
  per-event clips with `ffmpeg`, stores events in SQLite, and serves a
  self-contained dashboard.
- **Cameras connect outbound** to the hub. They expose no inbound port,
  hold no state, and release the V4L2 device whenever the hub tells them
  to be off — important when a camera is on battery.
- **Browsers and the MagicMirror module poll the hub's HTTP API.** The
  live MJPEG feed is a vanilla `<img src=…/stream.mjpg>` pointed at the
  hub. No special client software needed.
- **Detection is off by default.** Toggle it via the dashboard or the
  config file — the hub lazy-downloads the YOLO model on first enable.
- **Per-event clips** land in `~/Videos/SecurityCamera/<YYYY-MM-DD>/…`
  on the hub host. Old events sweep automatically (default retention 14
  days).
- **No internet required.** The system runs entirely on your LAN. The
  one exception is the first-time YOLO model download (~6 MB).

---

## Components and repo layout

```
LuxSecurityCamera/
├── install.sh                            # unified installer; pick a component
│
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

| Component | What it does | Where it runs | Tech |
|---|---|---|---|
| `hub/` | HTTP+WS server, frame buffer, detection, recording, events DB, dashboard | Linux/macOS host with Node 18+ (Windows manual) | Node.js, `ws`, `onnxruntime-node`, `sharp`, `better-sqlite3`, `ffmpeg` |
| `camera_node/` | USB webcam capture + WebSocket publisher | Raspberry Pi Zero 2 W (or any Linux Pi) | Python 3.11+, `opencv-python-headless`, `websockets` |
| `mm_module/MMM-LuxSecurityDisplay/` | MagicMirror² display module | MagicMirror Pi (optional) | Pure browser JS, no native deps |

---

## Verify

From any device on the LAN, after install:

```bash
curl http://<hub-host>:5000/healthz       # → ok
curl http://<hub-host>:5000/cams          # JSON list of registered cameras
```

Then open `http://<hub-host>:5000/` for the events dashboard. Walk past a
connected camera and you should see a new event appear with an inline
playable clip.

---

## Upgrading and re-installing

After `./install.sh` cleanup, only the surviving component's installer is
present on each device — that's the right one for upgrades there:

```bash
cd ~/LuxSecurityCamera && git pull && ./hub/install.sh           # on the hub host
cd ~/LuxSecurityCamera && git pull && ./camera_node/install.sh   # on a camera Pi
cd ~/LuxSecurityCamera && git pull && ./mm_module/install.sh     # on the MagicMirror Pi
```

All three are idempotent and leave existing config files alone.

**Hub acting up?** Re-running `./hub/install.sh` on the hub host is the
recommended fix for almost any hub problem — it rewrites the systemd unit
or launchd LaunchAgent and restarts the service while preserving your
config, events DB, and recorded clips. The installer probes for an
existing hub on this machine *and* on the network before touching
anything, and walks you through the right next step (re-install vs.
migrate vs. recover). See
[`INSTALLATION.md` § Re-installing / migrating the hub](INSTALLATION.md#re-installing--migrating-the-hub).

---

## More

- **[`INSTALLATION.md`](INSTALLATION.md)** — full step-by-step manual
  including OS prerequisites, troubleshooting, migration from the
  pre-split (embedded-hub) layout, and the "Doing it manually" paths if
  the installers don't fit your environment.
- **[`hub/README.md`](hub/README.md)** — hub config reference, Windows
  install recipe, full HTTP API.
- **[`camera_node/README.md`](camera_node/README.md)** — camera_node
  config reference and dev quickstart.
- **[`PRD.md`](PRD.md)** — architecture deep-dive, design decisions,
  roadmap.

---

## FAQ

### Do I need a MagicMirror?

No. The MagicMirror module is optional — it just shows one camera on a
mirror. The hub's built-in dashboard at `http://<hub-host>:5000/` is the
primary UI and works in any browser on your LAN (phone, tablet, laptop,
desktop).

### Can I run the hub on a Mac?

Yes. The installer detects macOS and registers a launchd LaunchAgent at
`~/Library/LaunchAgents/com.luxsecurityhub.plist`. It runs while you're
logged in (Macs typically auto-login on boot, so the hub comes back after
a restart). One quirk: macOS's AirPlay Receiver also wants port 5000 — if
you see `EADDRINUSE`, either disable AirPlay Receiver or change
`hub.port` in `~/.config/luxsecurityhub/config.yml`. See
[`hub/README.md`](hub/README.md#install--linux--macos) for details.

### Can I run the hub on Windows?

Yes, but the installer doesn't automate it yet. You can `npm install` and
`node src\hub.js` in the repo's `hub/` directory; the
[Windows section of `hub/README.md`](hub/README.md#install--windows) has a
step-by-step NSSM recipe for running it as a Windows Service.

### Can I run multiple cameras?

Yes. Run `./install.sh` (choose `camera`) on each Pi, giving each a
unique `cam_id` (`front`, `porch`, `garage`, etc.). All cameras connect
to the same hub, which routes everything by `cam_id`. The dashboard
shows them all.

### What happens if I install two hubs by mistake?

Both run independently — they don't conflict, but they don't share
events or clips either. Whichever one your cameras are configured to
point at is the "live" hub; the other is orphaned. The installer detects
this case (it probes the network when you confirm there's another hub
running) and walks you through migrating, recovering, or deciding to run
both intentionally before letting you proceed. See
[`INSTALLATION.md` § Re-installing / migrating the hub](INSTALLATION.md#re-installing--migrating-the-hub).

### How do I move the hub to a new machine?

Install the hub on the new machine — when the installer asks "do you
already have a hub on another machine?" answer yes and it'll show you
the migration steps:

1. Update each camera_node's `hub.url` config to point at the new host
   and restart the service.
2. Update the MagicMirror module's `hubUrl` in `config.js` if you use
   one, then restart MagicMirror.
3. Stop the hub on the old machine
   (`sudo systemctl disable --now lux-security-hub` on Linux, or
   `launchctl unload ~/Library/LaunchAgents/com.luxsecurityhub.plist`
   on macOS).

The wire protocol is unchanged, so the camera_nodes don't need
re-installation — just a config tweak.

### Where do recorded clips go?

`~/Videos/SecurityCamera/<YYYY-MM-DD>/<HH-MM-SS>_<cam_id>_person.mkv` on
the hub host. The events database is at
`~/.luxsecurityhub/events.db` (`/etc/lux-security-hub/` on Linux is for
config; data lives in the user's home).

### Does this connect to the internet?

No, the system is fully LAN-only. The single exception is the first-time
YOLO model download (~6 MB) when you enable detection — after that, the
model is cached at `~/.luxsecurityhub/models/` and no network is needed.
The hub has **no auth and no TLS** — designed for a trusted LAN. Don't
port-forward port 5000.

### Does detection record everything 24/7?

No. By default the camera streams continuously (so you can watch the
live feed in the dashboard) but **detection is off**. When you enable
it, the hub runs YOLO at ~2 fps and only records when a person is
actually in frame. Sub-2-second false positives are dropped. Default
retention is 14 days; old events are swept automatically.

### Does it work over WiFi? Cellular?

Yes to WiFi (the Pi Zero 2 W is 2.4 GHz only). Cellular is untested but
the cameras only need to reach the hub over IP — anything that gets you
that works.

### How do I uninstall?

```bash
# Hub (Linux):
sudo systemctl disable --now lux-security-hub
sudo rm /etc/systemd/system/lux-security-hub.service
sudo systemctl daemon-reload
sudo rm -rf /etc/lux-security-hub                      # config (optional)
rm -rf ~/.luxsecurityhub ~/Videos/SecurityCamera       # data (optional)

# Hub (macOS):
launchctl unload ~/Library/LaunchAgents/com.luxsecurityhub.plist
rm ~/Library/LaunchAgents/com.luxsecurityhub.plist
rm -rf ~/.config/luxsecurityhub                        # config (optional)
rm -rf ~/.luxsecurityhub ~/Videos/SecurityCamera       # data (optional)

# Camera node:
sudo systemctl disable --now camera-node
sudo rm /etc/systemd/system/camera-node.service
sudo rm -rf /etc/camera-node

# MagicMirror module:
rm ~/MagicMirror/modules/MMM-LuxSecurityDisplay
```

Then `rm -rf ~/LuxSecurityCamera` to remove the repo checkout.

### A camera connected, but its feed shows "Camera offline"

The camera is unreachable from the hub — most likely the WebSocket got
torn down. Check the camera_node logs:

```bash
ssh user@camera-pi 'journalctl -fu camera-node'
```

You should see `Connecting to hub at ws://…` followed by
`Hub requested state=on`. If the hub is responding but the camera shows
"requested state=off", flip it on via the dashboard or:

```bash
curl -X POST -H 'Content-Type: application/json' \
     -d '{"state":"on"}' http://<hub-host>:5000/cam/<cam_id>/toggle
```

### Migrating from the pre-split (embedded-hub) version

Earlier versions had the hub embedded inside MagicMirror's `MMM-DoorCam`
module. See
[`INSTALLATION.md § Migrating from the embedded hub`](INSTALLATION.md#migrating-from-the-embedded-hub)
for the walkthrough. The wire protocol is unchanged; only the hub moved.
