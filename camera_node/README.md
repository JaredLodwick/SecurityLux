# SecurityLux — camera_node

The Python service that runs on a Raspberry Pi Zero 2 W with a USB UVC
webcam. It captures frames and **publishes them over a single WebSocket to
SecurityLuxHub**. The hub buffers the latest frame and exposes it to viewers;
this client never opens an inbound port.

Cameras are small, low-power, often battery-backed devices, so the camera
side stays minimal:

- one outbound WebSocket connection
- binary JPEG frames pushed only while the feed is on
- a periodic JSON status message (battery, fps, resolution)
- accepts `{"type":"set_state","state":"on"|"off"}` from the hub

When the hub says "off", the camera releases the V4L2 device, so battery
draw drops to near-idle.

See the project PRD for the full product context — hardware choices, the
broader architecture, and end-to-end Pi provisioning. It lives at the repo
root as `PRD.md`.

## What's in this folder

```
camera_node/
  camera_node/         # the Python package (run via `python -m camera_node`)
    publisher.py       # WS client: frame pump, status pump, command receive
    camera.py          # capture thread + real/mock camera (unchanged)
    state.py           # on/off state machine (unchanged)
    config.py          # YAML config loader
    pisugar.py         # TCP client for the PiSugar daemon
  tests/               # pytest suite (no hardware required)
  deploy/camera-node.service
  config.example.yml
  requirements.txt
```

## Wire protocol (camera ↔ hub)

WebSocket `wss?://<hub>/cam/<cam_id>`.

- **camera → hub (binary)**: a JPEG frame. Last-writer-wins on the hub.
- **camera → hub (text JSON)**:
  - `{"type":"hello","cam_id":"front","capabilities":{...}}` once on connect.
  - `{"type":"status","cam_id":"front","state":"on","fps":15,"resolution":"640x480","battery_pct":87.5,"on_battery":true,"camera_available":true}` every ~5s.
- **hub → camera (text JSON)**:
  - `{"type":"set_state","state":"on"|"off"}` — drives the local state machine.
  - `{"type":"hello_ack","cam_id":"front"}` — informational.

Reconnects use exponential backoff (1s → 30s).

## Local dev quickstart (no Pi needed)

The camera layer transparently falls back to a mock source when there is no
working V4L2 device, so you can develop on a laptop. To exercise the full
pipeline you also need SecurityLuxHub running, or any `ws://` test server on
port 5000.

```bash
cd camera_node
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# Point at the hub (defaults to ws://meer.local:5000)
export CAMERA_NODE_CONFIG=$PWD/config.example.yml
python -m camera_node
```

You should see `Connecting to hub at ws://meer.local:5000/cam/front` in the
logs. Once the hub responds with `set_state: on` (e.g. via
`curl -X POST http://meer.local:5000/cam/front/toggle`),
the camera opens the device and starts streaming.

### Using a real camera

On the Pi (or any Linux box with a UVC webcam):

1. Confirm the device: `ls /dev/video*` and `v4l2-ctl --list-devices`.
2. Copy `config.example.yml` to `config.yml` and adjust `camera.device`,
   `camera.resolution`, `camera.fps`, and `camera.id`.
3. Set `hub.url` to your hub — e.g. `ws://meer.local:5000`.
4. Start the service: `python -m camera_node`.

Config is read from, in order: `$CAMERA_NODE_CONFIG` → `/etc/camera-node/config.yml`
→ `./config.yml` → built-in defaults.

## Deploying to the Pi

The fast path: clone the repo on the camera Pi and run the installer.

```bash
git clone https://github.com/JaredLodwick/SecurityLux.git ~/SecurityLux
cd ~/SecurityLux
./camera_node/install.sh
```

The script auto-detects the user and install path, installs apt + pip deps,
adds the user to the `video` group, bootstraps `/etc/camera-node/config.yml`
from the example, and registers a systemd unit (`camera-node.service`) that
starts on boot and auto-restarts on crash. It is idempotent — re-run it
after a `git pull` to pick up changes.

Verify from the hub Pi:

```bash
curl http://meer.local:5000/cams
# should list {"cam_id":"front","connected":true,...}
```

### Doing it manually instead

If the installer doesn't fit (different init system, custom layout, etc.),
do it by hand:

```bash
cd ~/SecurityLux/camera_node
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
sudo usermod -aG video "$USER"
sudo cp config.example.yml /etc/camera-node/config.yml   # then edit
.venv/bin/python -m camera_node      # foreground test run
```

For an auto-restart service, write your own systemd unit modelled on what
`install.sh` generates — `User=`, `WorkingDirectory=`, `ExecStart=` are the
only paths you need to template.

## Running the tests

```bash
cd camera_node
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pytest
```

Tests exercise the config loader, the state machine, and the PiSugar
parsers/client — no hardware or hub required.
