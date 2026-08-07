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
    publisher.py       # WS client: frame pump, status pump, command router
    camera.py          # capture thread + real/mock camera
    state.py           # on/off state machine
    config.py          # YAML config loader
    pisugar.py         # TCP client for the PiSugar daemon
    led.py             # optional NeoPixel door light (SPI)
    imaging.py         # rotation / flip / zoom, applied before JPEG encode
    controls.py        # V4L2 hardware controls via v4l2-ctl
  tests/               # pytest suite (no hardware required)
  deploy/camera-node.service
  config.example.yml
  requirements.txt
  requirements-led.txt # optional NeoPixel deps — Pi only
```

## Wire protocol (camera ↔ hub)

WebSocket `wss?://<hub>/cam/<cam_id>`.

- **camera → hub (binary)**: a JPEG frame. Last-writer-wins on the hub.
- **camera → hub (text JSON)**:
  - `{"type":"hello","cam_id":"front","capabilities":{...}}` once on connect.
  - `{"type":"status", ..., "battery_pct":87.5, "on_battery":true, "camera_available":true, "led_available":true, "uptime_s":4821}` every ~5s.
- **hub → camera (text JSON)**:
  - `{"type":"set_state","state":"on"|"off"}` — drives the local state machine.
  - `{"type":"led_config","enabled":true,"count":8,"maxBrightness":0.4}` — configure the strip.
  - `{"type":"led","stage":3,"pattern":"pulse","color":[255,160,40],"brightness":0.34,"periodMs":1100,"ttlMs":8000}` — play a stage.
  - `{"type":"restart_service"}` — exit cleanly so systemd restarts us.
  - `{"type":"reboot"}` — reboot the Pi.
  - `{"type":"hello_ack","cam_id":"front"}` — informational.

Reconnects use exponential backoff (1s → 30s).

## Image adjustments

Framing (rotation, mirroring, digital zoom, pan) and hardware controls
(brightness, contrast, exposure, white balance…) are both driven from the hub's
web UI — camera → **Adjust image** — with a live preview.

Everything is applied **here on the camera, before the JPEG encode**, so the
live feed, the hub's recordings, and the person detector all see the same
corrected picture. Doing it in the browser would fix only what you're looking
at and leave the detector staring at a sideways person.

`imaging.py` handles framing. It short-circuits entirely when nothing is set,
so an unadjusted camera pays no cost at all — not even a copy. With adjustments
active, 180° and flips are cheap array operations, 90/270 is a transpose plus a
flip, and zoom is a slice plus one resize: low single-digit milliseconds at
640×480, against a 66 ms budget at 15 fps.

`controls.py` handles the hardware side via `v4l2-ctl`, not OpenCV. OpenCV's
`CAP_PROP_BRIGHTNESS` and friends behave inconsistently across backends — some
normalise to 0-1, some pass raw driver units, and none report a control's
actual range or whether the camera has it. `v4l2-ctl --list-ctrls` gives all of
that, which is what makes it possible to show only the controls a given webcam
genuinely supports with sliders that span its real range.

Those are *hardware* controls: the sensor or driver applies them, so unlike the
geometry transforms they cost zero CPU per frame. Prefer them wherever both
exist.

`v4l-utils` is already in `apt-requirements.txt`. Without it, framing still
works and the panel explains why the rest is unavailable.

Note that 90° and 270° rotation swap width and height, so the camera's
effective resolution changes — and any zones drawn on the old orientation will
need redrawing.

## Remote restart and reboot

The hub can restart the publisher or reboot the Pi from its web UI. Two
things in the systemd unit make that work, and both are deliberate:

- **`Restart=always`**, not `on-failure`. A restart is implemented as a
  clean exit; `on-failure` would leave the service stopped.
- **`NoNewPrivileges=false`.** It otherwise blocks `sudo` outright, which
  would break reboot. The privilege granted is narrow: the installer writes
  `/etc/sudoers.d/securitylux-camera-node` allowing exactly
  `systemctl reboot` and `/sbin/reboot`, nothing else.

If reboot reports a failure from the dashboard, re-run
`camera_node/install.sh` on that Pi — the sudoers rule is almost certainly
missing. Restart works regardless and fixes most problems anyway.

## Door light (optional NeoPixel)

An 8-LED WS281x strip lights up when someone is at the door, escalating
from a brief cool sweep (passing) through a warm breathe (present) and an
amber pulse (standing there) to an amber-red chase (lingering). The hub
sends a stage; the animation runs locally at 50 fps so a WiFi hiccup
produces a smooth fade rather than a stutter.

### Wiring — SPI

```
NeoPixel DIN  ──►  GPIO10 / MOSI   (physical pin 19)
NeoPixel GND  ──►  Pi GND          (physical pin 6)   ← common ground is mandatory
NeoPixel 5V   ──►  5V supply
```

SPI rather than the more commonly documented PWM pin, for two reasons:
`rpi_ws281x` on a PWM pin requires **root** (and giving a network-facing
process root to blink an LED is a bad trade), and GPIO18 — the usual PWM
choice — conflicts with the Pi's onboard audio.

### Setup

```bash
sudo raspi-config          # Interface Options → SPI → Yes
echo 'core_freq_min=500' | sudo tee -a /boot/firmware/config.txt
sudo reboot

# then, in the camera_node venv:
pip install -r requirements-led.txt
```

`core_freq_min=500` matters: the SPI clock tracks the core clock, so CPU
frequency scaling can otherwise drift the WS2812 bit timing and produce
flicker or wrong colours.

Finally, enable the light for this camera in the hub's UI (camera →
**Camera settings** → *Door light*), and use **Test light** to check the
wiring without standing outside.

### ⚠️ Power

Eight LEDs at full white draw roughly **480 mA**. That is more than the Pi
Zero's 5V rail wants to supply while a PiSugar is also charging — you'll
get brownouts and a Pi that reboots under load. Brightness is capped at
**40%** by default and enforced on the camera as well as the hub, so a bad
command can't overdraw the rail. If you want it brighter, feed the strip
from its own 5V supply with a shared ground.

### No strip? Nothing to do.

Every hardware dependency is imported behind a guard. With no strip, no
SPI, or no Adafruit libraries installed, `led.py` becomes a no-op that logs
the reason once and the camera keeps streaming exactly as before.

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

119 tests exercising the config loader, the state machine, the PiSugar
parsers/client, the door light's animation maths and TTL expiry, the image
transforms, and the V4L2 control parser — no hardware, no SPI bus, no webcam
and no hub required.

The LED tests deliberately run with no Adafruit libraries installed and the
control tests with no `v4l2-ctl` present, which is also how we check that a
camera missing either degrades cleanly rather than failing to stream.
