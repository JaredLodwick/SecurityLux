# Door Cam — Pi Client

The Python service that runs on the Raspberry Pi Zero 2 W at the door. It
captures frames from a USB UVC webcam, serves them as an MJPEG stream over
HTTP for any device on the LAN (a browser, a MagicMirror²), and exposes a
small REST API for toggling the feed on/off and reporting status (uptime,
fps, resolution, PiSugar battery).

See the project PRD for the full product context — it covers hardware
choices, system architecture, the future roadmap, and the end-to-end Pi
provisioning steps. It lives at the repo root as `PRD.md`.

## What's in this folder

```
pi_client/
  doorcam/             # the Python package (run via `python -m doorcam`)
    server.py          # Flask app + HTTP routes
    camera.py          # capture thread + real/mock camera
    state.py           # on/off state machine
    config.py          # YAML config loader
    pisugar.py         # TCP client for the PiSugar daemon
  tests/               # pytest suite (no hardware required)
  deploy/doorcam.service
  config.example.yml
  requirements.txt
```

## HTTP API (stable contract)

| Method | Path           | Purpose                                           |
|--------|----------------|---------------------------------------------------|
| GET    | `/`            | Serves `../web/index.html` if present, else a tiny placeholder. |
| GET    | `/static/*`    | Passthrough to the sibling `web/` folder.         |
| GET    | `/stream.mjpg` | MJPEG stream. Returns **503 `{"error":"feed is off"}`** when off. |
| POST   | `/toggle`      | Flip state; or send `{"state":"on"\|"off"}` to set explicitly. |
| GET    | `/status`      | JSON telemetry (state, uptime, fps, battery, …). |
| GET    | `/healthz`     | Plaintext `ok`.                                   |

CORS is open (`Access-Control-Allow-Origin: *`) so the web frontend can call
the API from a different dev origin.

## Local dev quickstart (no Pi needed)

The camera layer transparently falls back to a mock source when there is no
working V4L2 device, so you can develop on a laptop.

```bash
cd pi_client
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

python -m doorcam
```

Then, from another terminal:

```bash
curl http://localhost:5000/healthz         # -> ok
curl http://localhost:5000/status          # -> JSON
curl -X POST http://localhost:5000/toggle  # -> {"state":"on"} (or "off")
# Start the feed, then open the stream in a browser:
#   http://localhost:5000/stream.mjpg
```

Logs will include `WARNING Using mock camera` when the fallback activates.

### Using a real camera

On the Pi (or any Linux box with a UVC webcam):

1. Confirm the device: `ls /dev/video*` and `v4l2-ctl --list-devices`.
2. Copy `config.example.yml` to `config.yml` and adjust `camera.device`,
   `camera.resolution`, and `camera.fps` as needed.
3. Start the service: `python -m doorcam`.
4. `curl http://localhost:5000/status` — `camera_available` should be `true`.

Config is read from, in order: `$DOORCAM_CONFIG` → `/etc/doorcam/config.yml`
→ `./config.yml` → built-in defaults.

## Deploying to the Pi

High-level steps (the PRD section "Pi setup instructions" has the full
provisioning story from flashing the SD card through enabling PiSugar and
avahi):

1. Copy the project to the Pi, e.g. `/opt/doorcam/`.
2. Create the virtualenv and install deps:
   ```bash
   cd /opt/doorcam/pi_client
   python3 -m venv .venv
   .venv/bin/pip install --upgrade pip
   .venv/bin/pip install -r requirements.txt
   ```
3. Install the systemd unit:
   ```bash
   sudo cp deploy/doorcam.service /etc/systemd/system/doorcam.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now doorcam
   sudo systemctl status doorcam
   ```
4. Verify:
   ```bash
   curl http://doorcam.local:5000/healthz
   curl http://doorcam.local:5000/status
   ```

The unit runs as `User=pi` and expects the project at
`/opt/doorcam/pi_client`. Use `systemctl edit doorcam` to override either.

## Running the tests

```bash
cd pi_client
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pytest
```

Tests do not require any hardware — they exercise the config loader, the
state machine, and the PiSugar parsers/client (the client tests spin up a
tiny in-process TCP server rather than hitting a real daemon).
