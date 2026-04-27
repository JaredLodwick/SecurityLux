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

1. **Camera Pi** — see [`pi_client/README.md`](pi_client/README.md) for OS
   flash, deps, config, and the systemd unit. Default config points at
   `ws://meer.local:5000` and registers as `cam_id: front`.
2. **MagicMirror Pi** — clone this repo somewhere (e.g. `~/DoorCamera`),
   then run:
   ```bash
   ./mm_module/install.sh
   ```
   That symlinks `~/MagicMirror/modules/MMM-DoorCam` into this repo and
   wires up the helper's `node_modules`. Add an `MMM-DoorCam` entry to
   `~/MagicMirror/config/config.js` (see `mm_module/MMM-DoorCam/README.md`)
   and restart MagicMirror.
3. **Verify** from the Mirror Pi:
   ```bash
   curl http://localhost:5000/healthz
   curl http://localhost:5000/cams
   ```
