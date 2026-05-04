# mm_module/

Source of truth for the `MMM-LuxSecurityDisplay` MagicMirror² module —
kept here (rather than in MagicMirror's own `modules/` directory) so it's
version-controlled alongside the rest of the system.

`MMM-LuxSecurityDisplay` is **a thin display client only.** All the work
(camera ingest, detection, recording, dashboard) lives in the standalone
[`hub/`](../hub/) at the repo root. Make sure that's running somewhere
reachable on your LAN before you bother installing the module.

See [`MMM-LuxSecurityDisplay/README.md`](MMM-LuxSecurityDisplay/README.md)
for the module's own documentation.

## Install

Run the installer from the repo root:

```bash
./mm_module/install.sh                  # auto-detects ~/MagicMirror
./mm_module/install.sh /path/to/MM      # or pass the MagicMirror root
```

It just creates one symlink:

- `<MagicMirror>/modules/MMM-LuxSecurityDisplay` → `mm_module/MMM-LuxSecurityDisplay/`

There are no node-side dependencies — the module is pure browser JS that
talks to the hub over `fetch()`. The installer does NOT touch MagicMirror's
`node_modules`. (It does clean up the legacy `MMM-DoorCam` symlink from
before the architecture split, if it finds one.)

Then add the module to `~/MagicMirror/config/config.js` and restart
MagicMirror.

## Why a symlink and not a copy?

A copy would mean two source-of-truth dirs to keep in sync. The symlink lets
edits land directly in this repo and show up live the next time MagicMirror
restarts.
