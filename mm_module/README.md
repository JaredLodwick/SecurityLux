# mm_module/

Source of truth for the `MMM-DoorCam` MagicMirror² module — kept here (rather
than in MagicMirror's own `modules/` directory) so it's version-controlled
alongside the camera client and the PRD.

`MMM-DoorCam` is dual-role: it's both the on-mirror UI and the hub server
that cameras connect into. See [`MMM-DoorCam/README.md`](MMM-DoorCam/README.md)
for the module's own documentation.

## Install

Run the installer from the repo root:

```bash
./mm_module/install.sh                  # auto-detects ~/MagicMirror
./mm_module/install.sh /path/to/MM      # or pass the MagicMirror root
```

It creates two symlinks (idempotent — safe to re-run):

1. `<MagicMirror>/modules/MMM-DoorCam` → `mm_module/MMM-DoorCam` (this dir).
   Lets MagicMirror find and load the module from the repo.
2. `mm_module/MMM-DoorCam/node_modules` → `<MagicMirror>/node_modules`.
   Lets `node_helper.js` resolve `require("ws")` and `require("node_helper")`
   from MagicMirror's bundled dependencies. Gitignored (the repo's
   `.gitignore` already excludes `node_modules/`).

Then add the module to `~/MagicMirror/config/config.js` and restart
MagicMirror.

## Why a symlink and not a copy?

A copy would mean two source-of-truth dirs to keep in sync. The symlink lets
edits land directly in this repo and show up live the next time MagicMirror
restarts.

The `node_modules` symlink is the awkward part: when MagicMirror loads the
module, Node resolves the file path through the symlink and walks up looking
for `node_modules` from the repo dir, where there isn't one. Pointing
`mm_module/MMM-DoorCam/node_modules` at MagicMirror's bundle gives Node
something to find without bundling our own copy of `ws`.
