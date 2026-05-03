# DoorCamera

Security-camera system for the front door. The MagicMirror² Pi (`meer.local`)
is the always-on hub; door cameras are low-power Raspberry Pi Zero 2 W units
that connect *out* to the hub over a single WebSocket and stream JPEG frames.
The hub buffers the latest frame and exposes it to the on-mirror UI and any
other LAN consumer.

See [`PRD.md`](PRD.md) for the full architecture, protocol, and roadmap.

## Repo layout

```
DoorCamera/
  pi_client/             # camera Pi: Python WebSocket publisher
    doorcam/             # the package (run via `python -m doorcam`)
    deploy/doorcam.service
    config.example.yml
    requirements.txt
    tests/
    README.md            # setup + dev guide for the camera side
  mm_module/             # source of truth for the MagicMirror module
    MMM-DoorCam/         # the hub: node_helper.js + browser UI
    install.sh           # symlinks the module into ~/MagicMirror/modules/
  PRD.md                 # product requirements document (v0.2)
```

## Quick start

Two Pis, one installer each.

1. **Camera Pi** (the door, e.g. `doorcam.local`):
   ```bash
   git clone https://github.com/JaredLodwick/DoorCamera.git ~/DoorCamera
   cd ~/DoorCamera
   ./pi_client/install.sh
   ```
   Installs apt + pip deps, registers a systemd unit (`doorcam.service`)
   that starts on boot and auto-restarts on crash, bootstraps
   `/etc/doorcam/config.yml`. Default config points at `ws://meer.local:5000`
   and registers as `cam_id: front`.

2. **MagicMirror Pi** (the hub, e.g. `meer.local`):
   ```bash
   git clone https://github.com/JaredLodwick/DoorCamera.git ~/DoorCamera
   cd ~/DoorCamera
   ./mm_module/install.sh
   ```
   Symlinks the module into MagicMirror, installs hub-side npm deps
   (`onnxruntime-node`, `sharp`, `better-sqlite3`), warns if `ffmpeg` is
   missing. Add an `MMM-DoorCam` entry to `~/MagicMirror/config/config.js`
   (see [`mm_module/MMM-DoorCam/README.md`](mm_module/MMM-DoorCam/README.md))
   and restart MagicMirror.

3. **Verify** from any LAN device:
   ```bash
   curl http://meer.local:5000/healthz
   curl http://meer.local:5000/cams
   ```
   Then open `http://meer.local:5000/` for the events dashboard.

Both installers are idempotent — re-run them after a `git pull` to upgrade.
