# mm_module/

Source of truth for the `MMM-SecurityLuxDisplay` MagicMirror² module —
kept here (rather than in MagicMirror's own `modules/` directory) so it's
version-controlled alongside the rest of the system.

`MMM-SecurityLuxDisplay` is **a thin display client only.** All the work
(camera ingest, detection, recording, dashboard) lives in the standalone
[`hub/`](../hub/) at the repo root. Make sure that's running somewhere
reachable on your LAN before you bother installing the module.

See [`MMM-SecurityLuxDisplay/README.md`](MMM-SecurityLuxDisplay/README.md)
for the module's own documentation.

## Install

Run the installer from the repo root:

```bash
./mm_module/install.sh                  # auto-detects ~/MagicMirror
./mm_module/install.sh /path/to/MM      # or pass the MagicMirror root
```

It just creates one symlink:

- `<MagicMirror>/modules/MMM-SecurityLuxDisplay` → `mm_module/MMM-SecurityLuxDisplay/`

There are no node-side dependencies — the module is pure browser JS that
talks to the hub over `fetch()`. The installer does NOT touch MagicMirror's
`node_modules`.

The installer also updates `~/MagicMirror/config/config.js` for you after
asking for the hub URL, camera ID, and MagicMirror position. It backs up the
previous config as `config.js.securitylux.bak.*`. Restart MagicMirror after
the installer finishes.

## Why a symlink and not a copy?

A copy would mean two source-of-truth dirs to keep in sync. The symlink lets
edits land directly in this repo and show up live the next time MagicMirror
restarts.
