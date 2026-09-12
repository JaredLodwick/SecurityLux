# SecurityLuxHub

Standalone hub for the SecurityLux camera system. Runs as a regular Node.js
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
- A desktop / NUC / x86 Linux box on the same LAN.
- A **Mac** (macOS, Apple Silicon or Intel) — installed as a launchd LaunchAgent.
- A **Windows** PC — manual install (see below).

## Install — Linux & macOS

The same installer covers both. Clone and run:

```bash
git clone https://github.com/JaredLodwick/SecurityLux.git ~/SecurityLux
cd ~/SecurityLux
./hub/install.sh
```

It detects your OS and dispatches:

**Linux (systemd):**

1. Verifies Node.js >= 18, npm, and systemd. Warns if `ffmpeg` is missing
   (detection still works, recording silently skips without it).
2. `npm install --omit=dev` inside `hub/` (pulls `onnxruntime-node`,
   `sharp`, `better-sqlite3`, `ws`, `js-yaml`).
3. Bootstraps `/etc/security-lux-hub/config.yml` from `config.example.yml`
   (only if absent — re-runs preserve customization).
4. Generates `/etc/systemd/system/security-lux-hub.service` with your
   user + install path templated in. `Restart=on-failure`, comes back on
   reboot.
5. Enables, starts, and verifies. Prints a summary of useful commands.

**macOS (launchd LaunchAgent):**

1. Same Node + npm sanity checks. Warns if `ffmpeg` is missing
   (`brew install ffmpeg`).
2. `npm install --omit=dev` inside `hub/`.
3. Bootstraps `~/.config/securityluxhub/config.yml` from `config.example.yml`.
   No sudo needed for any of this — everything is per-user.
4. Writes `~/Library/LaunchAgents/com.securityluxhub.plist` with `RunAtLoad`
   and `KeepAlive` on Crashed.
5. `launchctl load -w` it; verifies; prints useful commands.

> **macOS gotcha — port 5000.** Modern macOS runs an AirPlay Receiver on
> port 5000 by default. If the hub log shows
> `EADDRINUSE: address already in use 0.0.0.0:5000`, either:
> - Disable AirPlay Receiver: System Settings → General → AirDrop & Handoff
> - Or change the hub port: edit `~/.config/securityluxhub/config.yml`
>   and set `hub.port: 5001` (or anything free), then
>   `launchctl unload ~/Library/LaunchAgents/com.securityluxhub.plist`
>   and `launchctl load -w …` to restart.

The macOS install runs the hub as a **LaunchAgent** (per-user). It comes
back when you log in. Most Macs auto-login the user on boot, so the hub
is back after a restart. For "boot before login" behavior, install as a
LaunchDaemon under `/Library/LaunchDaemons/` instead — that requires
sudo + manual plist work; the installer doesn't do it for you.

The Linux + macOS installer is **idempotent** — re-run after `git pull`
to upgrade.

### Pre-flight: existing-hub detection

Before touching anything on disk, the installer:

1. Reads `hub.port` from any existing config and probes
   `http://localhost:<port>` for `/healthz` + `/cams`. If a hub is already
   running on this machine, it surfaces a "this looks like a re-install"
   message — defaults to **Yes, continue** (safe; config and events DB
   are preserved).
2. Asks whether you already have a hub running on **another** machine on
   your network. If you say yes, it probes that URL and shows a
   structured guidance menu for migrating, recovering, or running both
   — defaults to **No** (the most common right answer is "fix the
   existing one, don't stand up a second"). The installer is idempotent
   on the original host, and most "broken hub" problems are
   config-related, not install-corruption.

To bypass the prompts (e.g. for a scripted install):

```bash
SECURITY_LUX_PREFLIGHT_DONE=1 ./hub/install.sh
```

## Install — Windows

There's no auto-installer for Windows yet. Clone, install deps, and run
manually — or wrap it in a Windows Service yourself.

```powershell
# In an admin PowerShell (or a regular one if Node is on PATH):
git clone https://github.com/JaredLodwick/SecurityLux.git C:\SecurityLux
cd C:\SecurityLux\hub
npm install --omit=dev

# Optional: install ffmpeg via Chocolatey or Scoop for clip recording
#   choco install ffmpeg
#   scoop install ffmpeg

# Foreground (for testing):
node src\hub.js
```

Open `http://localhost:5000/` to see the dashboard.

To run it as a background service that survives reboots, the easiest
approach is [NSSM](https://nssm.cc/) ("the non-sucking service manager"):

```powershell
# After downloading NSSM and putting nssm.exe on your PATH:
nssm install SecurityLuxHub "C:\Program Files\nodejs\node.exe" "C:\SecurityLux\hub\src\hub.js"
nssm set    SecurityLuxHub AppDirectory "C:\SecurityLux\hub"
nssm set    SecurityLuxHub AppEnvironmentExtra "SECURITY_LUX_HUB_CONFIG=%USERPROFILE%\.config\securityluxhub\config.yml"
nssm set    SecurityLuxHub AppStdout "%USERPROFILE%\AppData\Local\SecurityLuxHub\stdout.log"
nssm set    SecurityLuxHub AppStderr "%USERPROFILE%\AppData\Local\SecurityLuxHub\stderr.log"
nssm start  SecurityLuxHub

# Bootstrap the config dir if it doesn't exist yet:
mkdir "$env:USERPROFILE\.config\securityluxhub"
copy config.example.yml "$env:USERPROFILE\.config\securityluxhub\config.yml"
```

Manage with `nssm restart SecurityLuxHub`, `nssm stop SecurityLuxHub`, etc.

A first-class `install.ps1` is on the roadmap; PRs welcome.

## Run without a service manager (dev / testing, any OS)

```bash
cd hub
npm install
node src/hub.js                                   # uses ~/.config/securityluxhub/config.yml or built-in defaults
SECURITY_LUX_HUB_CONFIG=/tmp/securityluxhub.yml node src/hub.js     # or point at any YAML
node src/hub.js /path/to/config.yml               # or pass it as a CLI arg
```

The hub binds to `0.0.0.0:5000` by default. Open `http://<host>:5000/`
for the events dashboard. Config search order:

1. CLI arg (`node src/hub.js /path/to/config.yml`)
2. `$SECURITY_LUX_HUB_CONFIG` env var
3. `~/.config/securityluxhub/config.yml` (user-level; cross-OS)
4. `/etc/security-lux-hub/config.yml` (system-level; Linux/systemd)
5. Built-in defaults (with a `config file not found` warning)

## HTTP endpoints

### Cameras

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/`                       | The dashboard. |
| `GET`  | `/healthz`                | Plain `ok`. |
| `GET`  | `/cams`                   | Every registered camera + last-known status. |
| `GET`  | `/cam/<id>/status`        | One camera: state, connected, fps, battery, current_detection, behavior, led_stage, uptime, reconnects. |
| `GET`  | `/cam/<id>/stream.mjpg`   | Multipart MJPEG of the buffered frames. |
| `GET`  | `/cam/<id>/snapshot.jpg`  | Newest buffered frame as a single JPEG. Used by the zone editor and as a fallback when a stream can't be opened. |
| `POST` | `/cam/<id>/toggle`        | Body `{"state":"on"\|"off"}` to set; no body to flip. |
| `POST` | `/cam/<id>/detection`     | Body `{"enabled": bool}` — per-camera detection mute. The hub-wide `/detection` controls whether the detector worker runs at all; this just hides one camera's frames from inference. |
| `POST` | `/cam/<id>/restart`       | Restart the camera's publisher service (~2 s). |
| `POST` | `/cam/<id>/reboot`        | Reboot the camera Pi (~40 s; needs the installer's sudoers rule). |
| `POST` | `/cam/<id>/led/test`      | Body `{"stage": 0-4}` — fire a door-light pattern to check wiring. |
| `GET`  | `/cam/<id>/timeline`      | Coverage runs, segments and event markers for a window (`from`, `to` epoch ms). |
| `GET`  | `/cam/<id>/timeline/days` | Calendar days that have footage — the day picker, and "how far back can I go". |
| `GET`  | `/cam/<id>/timeline/seek` | `at=<epoch ms>` → which segment and what offset. Reports the nearest footage when the instant falls in a gap. |
| `POST` | `/cam/<id>/timeline/save` | `{fromMs, toMs}` — protect every segment overlapping a range. |
| `GET`  | `/cam/<id>/continuous`    | Whether the reel is running for this camera, and why not if it isn't. |
| `GET`  | `/recordings/<id>/video.mp4` | A segment, with `Range` support (required for seeking). |
| `GET`  | `/recordings/<id>/next`   | The following segment, or null at a real gap. |
| `POST` | `/recordings/<id>/protect`| `{protected: bool}` — save or release one segment. |
| `GET`  | `/cam/<id>/controls`      | Everything the image panel renders from: current framing, the V4L2 controls this camera reports supporting (with real ranges), stored values, and the effective output resolution. |
| `PUT`  | `/cam/<id>/controls`      | Body `{ image?: {rotation, flipHorizontal, flipVertical, zoom, panX, panY}, values?: {control: number} }`. Framing and hardware controls in one request, since the panel edits both together. |
| `POST` | `/cam/<id>/controls/reset`| Body `{"scope": "all"\|"image"\|"hardware"}` — back to defaults. |
| `POST` | `/cam/<id>/controls/refresh`| Ask the camera to re-probe its controls. Use after swapping the webcam. |
| `GET`/`PUT` | `/cam/<id>/settings` | Per-camera setting overrides. `PUT` a key to `null` to clear it and go back to inheriting. |
| `GET`/`PUT` | `/cam/<id>/zones`    | Named zones. `PUT` replaces the whole set. |

### Events

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/events`                 | Filterable list. Params: `cam`, `since`, `until`, `type`, `behavior`, `profile`, `clips`, `limit`, `offset`. |
| `GET`  | `/cam/<id>/events`        | The same, scoped to one camera. |
| `GET`  | `/events/latest?cam=<id>` | Most recent event — what the mirror module displays. |
| `GET`  | `/events/<id>`            | One event. |
| `GET`  | `/events/<id>/clip.<ext>` | The clip, with `Range` support. |
| `GET`  | `/events/<id>/thumb.jpg`  | The event thumbnail. |
| `POST` | `/events/<id>/redescribe` | Rewrite the description from the current zones. |
| `POST` | `/events/redescribe`      | Body `{"cam": "front"}` — rewrite in bulk after renaming zones. |
| `DELETE` | `/events/<id>`          | Delete the event and its files. |

### Hub

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/hub/info`               | Version, PID, Node version, uptime, camera count, log level, event-store health. |
| `POST` | `/hub/restart`            | Restarts the hub process — see [§ Controlling the hub](#controlling-the-hub) below. |

### Settings, storage, detection, profiles

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/settings/schema`        | Every setting's type, bounds, label, and help text. The dashboard renders its controls from this, so the UI can't offer a value the hub rejects. |
| `GET`/`PUT` | `/settings`          | Hub-wide settings. A `PUT` is all-or-nothing. |
| `GET`  | `/detection`              | `{ enabled, available, error, stats, recording_paused, clock_ok }`. |
| `POST` | `/detection`              | Body `{"enabled": bool}` to start/stop the detector at runtime. |
| `GET`  | `/storage`                | Usage, limits, per-camera breakdown, projected runway. |
| `POST` | `/storage/prune`          | Run the retention sweep now. |
| `POST` | `/storage/backup`         | Write a dated `events.db` copy. |
| `GET`/`POST` | `/profiles`         | List / create profiles. |
| `GET`/`PATCH`/`DELETE` | `/profiles/<id>` | One profile. |
| `GET`/`POST` | `/profiles/<id>/samples` | Face samples. `POST` `{eventId}` to enrol from an event thumbnail, or `{imageBase64}` to upload. |
| `DELETE` | `/profiles/<id>/samples/<sid>` | Remove a sample. |
| `GET`  | `/recognition`            | Face-recognition availability (currently always unavailable — see below). |

CORS is wide-open — designed for a trusted LAN. The wildcard is also what
lets a browser on another host read MJPEG pixels back for the stream stall
detector. Do **not** expose port 5000 to the public internet without
putting auth + TLS in front of it.

## WebSocket (camera ↔ hub)

`ws://<hub>:5000/cam/<cam_id>` — one connection per camera node.

**camera → hub**
- *binary:* a JPEG frame. Last-writer-wins, and pushed into the pre-roll ring buffer.
- *text:* `{"type":"hello", "cam_id", "capabilities":{...}}` once on connect, then `{"type":"status", ...}` every ~5 s.

**hub → camera**
- `{"type":"set_state","state":"on"|"off"}` and `{"type":"hello_ack","cam_id":"..."}`
- `{"type":"led_config","enabled":true,"count":8,"maxBrightness":0.4}`
- `{"type":"led","stage":3,"pattern":"pulse","color":[255,160,40],"brightness":0.34,"periodMs":1100,"ttlMs":8000}`
- `{"type":"image_config","rotation":90,"flipHorizontal":false,"zoom":2,"panX":-0.4,"panY":0}`
- `{"type":"camera_controls","values":{"brightness":20}}` / `{"type":"get_camera_controls"}` / `{"type":"reset_camera_controls"}`
- `{"type":"restart_service"}` / `{"type":"reboot"}`

The camera replies to the image messages with `image_state` (the resolved
geometry, since values are clamped camera-side) and `camera_controls` (what it
supports, with the driver's real ranges).

LED commands carry a TTL and are re-sent at half of it while a stage is
held. The camera fades to idle if it stops hearing from the hub, so a hub
crash mid-event leaves the porch dark rather than lit all night.

## Settings

Settings resolve in layers:

```
built-in defaults  →  config.yml  →  saved in the web UI  →  per-camera override
```

`config.yml` bootstraps and covers the things that must be known before the
database exists (bind port, database path, model URL). Everything else —
recording, retention, detection tuning, LED, zones — is editable at
`http://<hub>:5000/#/settings` and stored in the database.

A value you changed in the UI wins over the file. If editing `config.yml`
appears to do nothing, clear the override in the UI to hand control back.

Every setting is declared once in `src/settings.js` with its type, bounds,
and help text; validation, the API, and the UI controls are all derived
from that one declaration.

## Controlling the hub

The **Settings** page has a **Hub** card (version, uptime, camera count,
event-store health) with a **Restart hub** button, alongside everything
the dashboard already had for cameras (toggle, restart, reboot, image
adjustments, LED test).

A Node process can't restart itself in place, so this works the same way
the existing camera restart button does: `POST /hub/restart` shuts the
hub down cleanly (drains sessions, stops recorders, closes the database)
and exits with a non-zero code, which is exactly what `Restart=on-failure`
(the systemd unit) and `KeepAlive.SuccessfulExit: false` (the macOS
LaunchAgent) are watching for — the service manager brings it straight
back. No install/config change needed for this to work on an existing
install. The restart is logged to `system.log` first, so it reads as
"restart requested" rather than looking like an unexplained crash.

Cameras reconnect on their own once the hub is back; live streams and the
dashboard drop for a few seconds during the restart.

## Logs

Everything the hub logs goes to stdout/stderr, so `journalctl -fu
security-lux-hub` (Linux) or `tail -f ~/Library/Logs/SecurityLuxHub*.log`
(macOS) always shows the complete picture, same as before. It's also split
into per-category files under `logging.dir` (default
`~/.securityluxhub/logs/`) so a chatty subsystem doesn't bury a rare but
important line from another one:

| File | What's in it |
|---|---|
| `system.log`     | Service lifecycle, camera connect/disconnect and offline detection, storage sweeps/backups, settings changes, HTTP errors — everything that isn't detection or recording. |
| `motion.log`      | Detector ticks and latency, per-camera sessions starting/ending, tracked behaviour (passing/approaching/dwelling/loitering), door-light stage changes. |
| `recording.log`   | Event-clip and continuous-recording ffmpeg processes: start/stop, segment writes, and any ffmpeg stderr lines that looked like a real problem. |

```bash
tail -f ~/.securityluxhub/logs/system.log      # "is anything actually broken"
tail -f ~/.securityluxhub/logs/motion.log      # "why did/didn't this trigger"
tail -f ~/.securityluxhub/logs/recording.log   # ffmpeg-side recording issues
```

Each file rotates once it passes `logging.maxFileSizeMb` (default 10 MB),
keeping `logging.maxBackupFiles` (default 3) old copies alongside it
(`system.log.1`, `system.log.2`, …).

`logging.level` (`debug`/`info`/`warn`/`error`) also lives in Settings →
System as **Log level** and takes effect immediately, no restart — turn on
`debug` while chasing something, then turn it back down.

**A hub or camera that just stops, with nothing in the log:** a clean
uncaught exception or unhandled rejection is logged to `system.log` (and
the journal) before the process exits, so start there. If there's truly
nothing at the moment it died, suspect something the process itself
couldn't have logged — most likely the OOM killer (check `dmesg` /
`journalctl -k` for a `Killed process` line) or a power/SD-card fault on a
Pi. `systemctl status security-lux-hub` / `camera-node` also shows the
last exit code and how many times the unit has restarted, which tells you
whether it's crash-looping versus a one-off.

## Continuous recording

Off by default. Turn on **Record continuously** (Settings → Continuous
recording) and each camera gets a long-lived ffmpeg writing rolling segments to
`<clipsRoot>/continuous/<camId>/`, which the **Timeline** tab scrubs through.

Two decisions carry the design:

**Segments, not one long file.** Chunks are the unit of both eviction and
seeking. A single growing file can't be partially deleted to reclaim space, and
can't be played until it's closed.

**A fixed frame rate, even when the camera goes quiet.** The pump emits exactly
`continuous.fps` frames per second, repeating the last frame if nothing new has
arrived. That is what makes video time equal wall-clock time, which is what
makes "scrub to 14:32" land on 14:32 — seeking becomes
`(wanted - segmentStart)` rather than an index lookup.

Feeding only the frames that happen to arrive would look more efficient and
would quietly break the feature: a camera that dropped to 3 fps for a minute
would leave everything after it in that segment sitting at the wrong timestamp,
drifting further the deeper you scrub. Repeated frames cost almost nothing —
x264 encodes a static image as a handful of bytes.

A camera that goes away is tolerated for 10 seconds by repeating its last
frame, so a WiFi blip doesn't shred the recording. Past that the segment ends
and a new one starts on return, leaving an honest gap on the timeline.

Segment filenames are timestamps in a flat per-camera directory. A `YYYY-MM-DD/`
sub-directory would read better, but the segment muxer doesn't create
directories and has no option to (`-strftime_mkdir` belongs to the image2 muxer),
so it fails at every midnight rollover.

### Disk

Around 1.2 GB per camera per day at the defaults, varying widely with scene
activity. Budget is `storage.continuousMaxGB` (8 GB default). Continuous
footage is **always evicted before event clips**, including in the low-disk
emergency path, and protected ("saved") segments are never evicted at all —
that distinction is the whole point of being able to save a moment.

## Image adjustments

Click the **gear in the corner of any camera feed**. The panel slides in over
one edge of the frame and the rest of the picture keeps streaming underneath, so
you can see what each control does as you change it. Two groups:

**Framing** — rotation, mirroring, digital zoom and pan. Applied in software on
the camera. `is_identity` short-circuits the whole pipeline, so a camera you
haven't adjusted pays nothing; when active it's a few milliseconds a frame
against a 66 ms budget at 15 fps.

**Image** — brightness, contrast, saturation, sharpness, gain, exposure, white
balance, anti-flicker. These are V4L2 controls applied by the camera's own
driver, so they cost **zero CPU** regardless of how far you push them. Prefer
them over software equivalents.

The second group is built entirely from what the camera reports. UVC webcams
vary enormously — one might expose eleven controls and another three — so
nothing is shown that the camera didn't say it has, with the driver's real
min/max rather than a guessed range. Controls the driver marks inactive (manual
exposure while auto-exposure is on) are greyed out rather than offered as
sliders that silently do nothing.

Everything is applied on the camera *before* the JPEG encode, so the live feed,
the recordings, and the detector all see the same corrected image. Rotating in
the browser with CSS would fix only what you're looking at and leave the
detector staring at a sideways person, which is exactly when you most need
detection to work.

Two things worth knowing:

- **Rotation invalidates zones.** They're normalized coordinates on the rotated
  image, so turning the picture moves it underneath them. The UI warns and
  offers to reopen the zone editor.
- **Hardware values are stored on the hub and re-applied on every reconnect.**
  V4L2 values live in the camera's driver and are lost when the Pi reboots —
  without this, a power cut would silently undo your tuning and leave a dark
  doorway dark.

Requires `v4l-utils` on the camera Pi (already an apt dependency). Without it,
framing still works and the panel says why the rest is missing.

## Storage

Three independent limits, all editable under **Settings → Storage**:

- `storage.retentionDays` (default 14) — delete events older than this.
- `storage.maxTotalGB` (default 16) — reclaim oldest **video** first when
  over budget. Event rows survive with `clip_pruned: true`, so you keep the
  history and lose only the footage.
- `storage.minFreeGB` (default 4) — a hard floor on the filesystem. Below
  it the hub prunes aggressively and then stops writing clips while
  continuing to log events, rather than letting a full disk break SQLite.

The sweep runs every 15 minutes and again after every clip finalizes.
`events.db` is backed up nightly to `~/.securityluxhub/backups/`, seven
copies kept — clips are re-recordable, your zones and profiles are not.

## Face recognition

Not active. Profiles, clearances, enrollment, sample storage, and the
matching maths are all implemented and tested; what's missing is the model
that turns a face into an embedding. `GET /recognition` reports this, and
the Profiles page says so plainly rather than implying the hub is silently
identifying people.

To finish it: publish SCRFD-500m and MobileFaceNet ONNX files to the
`models-v1` release and implement `Recognizer._embed()` in
`src/recognize.js`. The header comment there has the full recipe.

## Tests

```bash
cd hub
npm install
npm test            # equivalent to: node --test tests/*.test.js
```

111 tests covering the event store and migrations, the session state
machine, tracking and behaviour classification, zone geometry, the
description templates, the frame ring buffer, settings resolution and
validation, and the storage limits. The detector and recorder are I/O-bound
and verified end-to-end on the hub.

## See also

- `../camera_node/` — the Pi Zero publisher
- `../mm_module/MMM-SecurityLuxDisplay/` — optional MagicMirror display
- `../PRD.md` — full product / architecture doc
