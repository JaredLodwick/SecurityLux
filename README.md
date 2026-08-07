# SecurityLux

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
git clone https://github.com/JaredLodwick/SecurityLux.git ~/SecurityLux
cd ~/SecurityLux
./install.sh             # choose 1) hub
```

When it finishes, open `http://<hub-host>:5000/` from any device on your
LAN — you'll see an empty dashboard waiting for cameras.

### Step 2 — install a camera node (one per camera)

On each Raspberry Pi attached to a USB webcam (Pi Zero 2 W is the target
form factor; any Linux Pi works):

```bash
git clone https://github.com/JaredLodwick/SecurityLux.git ~/SecurityLux
cd ~/SecurityLux
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
cd ~/SecurityLux
./install.sh             # choose 3) viewer
```

You'll be asked for your MagicMirror install path, hub URL, camera ID, and
screen position. The installer symlinks the module and updates
`~/MagicMirror/config/config.js` for you, keeping a timestamped backup.

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
| camera_node       | ====== WebSocket ========>  |  SecurityLuxHub    |
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
- **Per-event clips** land in `~/Videos/SecurityLux/<YYYY-MM-DD>/…` on the
  hub host, in h264/mp4. Each clip includes ~5 seconds *before* the
  detection fired and ~5 seconds after, so you see the walk-up and the
  walk-away rather than opening on someone already in frame.
- **Storage is bounded three ways** — by age, by a total clip budget, and
  by a hard floor on free disk. A full card can't take the hub down.
- **Events are described in plain English.** Draw and name zones on a
  camera ("trash room door", "driveway") and events read like
  *"Someone approached the trash room door and stood there for 12
  seconds."*
- **No internet required.** The system runs entirely on your LAN — including
  event descriptions and sunrise/sunset. The one exception is the
  first-time YOLO model download (~6 MB).

---

## Components and repo layout

```
SecurityLux/
├── install.sh                            # unified installer; pick a component
│
├── hub/                                  # standalone hub server (Node.js)
│   ├── src/                              #   server.js, routes.js, detector.*, store.js,
│   │                                     #   recorder.js, session.js, tracker.js, zones.js,
│   │                                     #   describe.js, storage.js, settings.js, led.js
│   ├── web/                              #   dashboard: index.html, css/, js/
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
│   ├── requirements-led.txt              #   optional NeoPixel deps (Pi only)
│   └── install.sh
│
└── mm_module/                            # optional MagicMirror display
    ├── MMM-SecurityLuxDisplay/
    └── install.sh
```

| Component | What it does | Where it runs | Tech |
|---|---|---|---|
| `hub/` | HTTP+WS server, frame buffer, detection, recording, events DB, dashboard | Linux/macOS host with Node 18+ (Windows manual) | Node.js, `ws`, `onnxruntime-node`, `sharp`, `better-sqlite3`, `ffmpeg` |
| `camera_node/` | USB webcam capture + WebSocket publisher | Raspberry Pi Zero 2 W (or any Linux Pi) | Python 3.11+, `opencv-python-headless`, `websockets` |
| `mm_module/MMM-SecurityLuxDisplay/` | MagicMirror² display module | MagicMirror Pi (optional) | Pure browser JS, no native deps |

---

## Verify

From any device on the LAN, after install:

```bash
curl http://<hub-host>:5000/healthz       # → ok
curl http://<hub-host>:5000/cams          # JSON list of registered cameras
```

Then open `http://<hub-host>:5000/` for the dashboard. Walk past a
connected camera and you should see a new event appear with a thumbnail,
a plain-English description, and an inline playable clip.

---

## Making the picture look right

Open a camera in the dashboard and click the **gear in the corner of the
feed**. The controls slide in over one edge of the picture, and the rest of
the feed keeps streaming live underneath — so you watch the actual image
change as you drag a slider, rather than squinting at a thumbnail in a dialog.

**Framing** — rotation (for a camera mounted sideways or upside down),
horizontal/vertical mirroring, and digital zoom with pan to fill the frame with
the bit you care about.

**Image** — brightness, contrast, saturation, sharpness, gain, exposure, white
balance and anti-flicker, depending on what your webcam supports. Only the
controls your camera actually has are shown, with its real ranges — no sliders
that silently do nothing.

Everything is applied on the camera before the video is encoded, so the live
feed, the recordings, and the person detector all see the same corrected image.
That last part matters: rotating the picture only in your browser would leave
the detector looking at a sideways person, and it's much worse at recognising
those.

Two things to know:

- **Rotating invalidates any zones you've drawn** — they're positions on the
  picture, and rotating moves the picture underneath them. The UI warns you and
  offers to reopen the zone editor.
- **Your settings survive a camera reboot.** Brightness and friends live in the
  camera's driver and reset when it loses power, so the hub stores them and
  re-applies them whenever the camera reconnects.

Brightness/contrast/exposure need `v4l-utils` on the camera Pi (the installer
puts it there). Framing works regardless.

## Getting good descriptions

Out of the box an event reads *"Someone was at the front door camera for
12 seconds."* Correct, but not the interesting version. Two minutes of
setup fixes that:

1. Open the camera in the dashboard and click **Zones**.
2. Drag boxes over the things that matter and name them the way you'd say
   them out loud — `trash room door`, `driveway`, `walkway`. The names are
   used verbatim, so `trash room door` reads far better than `Zone 2`.
3. Set the kind: **door** for entrances, **path** for walkways, **area**
   for anything else, and **ignore** for regions that generate false
   positives — a swaying branch, a neighbour's lit window, a road with
   passing cars. Detections inside an `ignore` zone are discarded outright.
4. Save. You'll be offered the chance to rewrite existing events using the
   new names, so renaming a zone fixes your history, not just the future.

Events then read like *"Someone walked from the driveway to the trash room
door."*

A person is judged to be in a zone by **where their feet are**, not their
middle — so standing close to the camera doesn't put someone in the wrong
zone.

---

## Storage

The hub records to `~/Videos/SecurityLux/` and bounds it three ways, all
editable under **Settings → Storage**:

| Limit | Default | What happens |
|---|---|---|
| Keep events for | 14 days | Older events and their video are deleted |
| Clip storage budget | 16 GB | Oldest **video** is reclaimed first; the event rows survive, so you keep the history and lose only the footage |
| Reserve free disk | 4 GB | A hard floor. Below it the hub prunes hard and, if that isn't enough, stops writing new clips while still logging events |

Recording defaults to h264/mp4, which is roughly **13× smaller** than the
MJPEG the camera sends (~2 MB/minute instead of ~27 MB/minute) and plays
natively in every browser including iOS Safari. On a 64 GB card that's the
difference between about 25 hours of event video and about 330. It costs
around 10% of one Pi 4 core per camera. If your hub is genuinely
CPU-starved, `recording.codec: mkv` restores the old zero-CPU stream-copy.

The Storage page shows current usage, a per-camera breakdown, and a
projected runway at your actual recording rate.

---

## Upgrading and re-installing

After `./install.sh` cleanup, only the surviving component's installer is
present on each device — that's the right one for upgrades there:

```bash
cd ~/SecurityLux && git pull && ./hub/install.sh           # on the hub host
cd ~/SecurityLux && git pull && ./camera_node/install.sh   # on a camera Pi
cd ~/SecurityLux && git pull && ./mm_module/install.sh     # on the MagicMirror Pi
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
`~/Library/LaunchAgents/com.securityluxhub.plist`. It runs while you're
logged in (Macs typically auto-login on boot, so the hub comes back after
a restart). One quirk: macOS's AirPlay Receiver also wants port 5000 — if
you see `EADDRINUSE`, either disable AirPlay Receiver or change
`hub.port` in `~/.config/securityluxhub/config.yml`. See
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
   (`sudo systemctl disable --now security-lux-hub` on Linux, or
   `launchctl unload ~/Library/LaunchAgents/com.securityluxhub.plist`
   on macOS).

The wire protocol is unchanged, so the camera_nodes don't need
re-installation — just a config tweak.

### Where do recorded clips go?

`~/Videos/SecurityLux/<YYYY-MM-DD>/<HH-MM-SS>_<cam_id>_person.mp4` on the
hub host, with a matching `.jpg` thumbnail. The database is at
`~/.securityluxhub/events.db` (`/etc/security-lux-hub/` on Linux is for
config; data lives in the user's home), backed up nightly to
`~/.securityluxhub/backups/` with seven copies kept.

That database holds your settings, zones, and profiles as well as the
event log. Clips are re-recordable; those aren't — which is why it's the
thing that gets backed up.

### My feed goes black after a few minutes. / The feed breaks when I unlock my phone.

Both were real bugs, fixed. The MagicMirror module used to run a blind
5-minute "refresh" timer that tore down the video connection without
successfully reopening it, and nothing recovered a stream that died while
the page was backgrounded.

Streams now reconnect on evidence rather than on a timer: an error, the
page becoming visible again, restoring from the back/forward cache, or —
the case nothing else catches — the picture being frozen while the hub
reports it's still sending fresh frames. That last one is detected by
sampling the image into a tiny canvas and checksumming it, because a
wedged decoder fires no events at all.

If you're still seeing it, make sure the MagicMirror module is up to date
(`./mm_module/install.sh` re-syncs the shared code) and restart
MagicMirror.

### Can I turn cameras off or reboot them from the dashboard?

Yes. Open a camera and use **Restart** or **Reboot**.

Reach for **Restart** first: it exits the camera's publisher and systemd
brings it back in about two seconds, which fixes nearly every camera
problem. **Reboot** restarts the whole Pi and takes about a minute; it
needs the scoped sudoers rule that `camera_node/install.sh` installs, so
re-run that installer on the camera if reboot reports a failure.

### My camera is mounted sideways / the picture is too dark

Click the **gear in the corner of the feed**. Rotation fixes the mounting;
brightness, contrast, gain and exposure fix the picture. See "Making the
picture look right" above.

If the only thing you see is the framing controls, the camera Pi is missing
`v4l2-ctl` — `sudo apt install v4l-utils` on that Pi and hit **Re-detect**.

A dark doorway is usually better fixed with **backlight compensation** (if your
webcam has it) or by turning **auto exposure** off and raising the exposure time
manually, rather than by winding brightness up — brightness lifts the whole
image including the noise, whereas exposure actually collects more light.

### What's the LED strip for?

An optional 8-LED NeoPixel wired to a camera Pi lights up when someone is
at the door, with escalating patterns: a brief cool sweep for someone
passing, a warm breathe when they're present, a faster amber pulse if they
stand there, and an amber-red chase if they linger.

Wire the data line to **GPIO10 / MOSI (physical pin 19)** and share a
ground, enable SPI, then `pip install -r requirements-led.txt` on the Pi
and turn the light on in that camera's settings. There's a **Test light**
button so you can check the wiring without standing outside.

SPI is used rather than the more commonly documented PWM pin because it
doesn't require running the camera service as root and doesn't conflict
with onboard audio. One caution: eight LEDs at full white draw ~480 mA,
which is more than the Pi Zero's 5V rail wants to give while a PiSugar is
charging — brightness is capped at 40% by default for that reason.

### Does it recognise faces?

Not yet. You can create profiles, set clearance levels, and enrol faces
(including in one click from an event thumbnail), and all of that is
stored properly. What's missing is the model that turns a face into a
comparable fingerprint — those files still need publishing. Until then
events are logged as generic person detections, and the Profiles page says
so rather than implying otherwise.

### Does this connect to the internet?

No, the system is fully LAN-only. The single exception is the first-time
YOLO model download (~6 MB) when you enable detection — after that, the
model is cached at `~/.securityluxhub/models/` and no network is needed.
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
sudo systemctl disable --now security-lux-hub
sudo rm /etc/systemd/system/security-lux-hub.service
sudo systemctl daemon-reload
sudo rm -rf /etc/security-lux-hub                      # config (optional)
rm -rf ~/.securityluxhub ~/Videos/SecurityLux       # data (optional)

# Hub (macOS):
launchctl unload ~/Library/LaunchAgents/com.securityluxhub.plist
rm ~/Library/LaunchAgents/com.securityluxhub.plist
rm -rf ~/.config/securityluxhub                        # config (optional)
rm -rf ~/.securityluxhub ~/Videos/SecurityLux       # data (optional)

# Camera node:
sudo systemctl disable --now camera-node
sudo rm /etc/systemd/system/camera-node.service
sudo rm -rf /etc/camera-node

# MagicMirror module:
rm ~/MagicMirror/modules/MMM-SecurityLuxDisplay
```

Then `rm -rf ~/SecurityLux` to remove the repo checkout.

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

Earlier versions had the hub embedded inside a MagicMirror module. See
[`INSTALLATION.md § Migrating from the embedded hub`](INSTALLATION.md#migrating-from-the-embedded-hub)
for the walkthrough. The wire protocol is unchanged; only the hub moved.
