# MMM-SecurityLuxDisplay

A MagicMirror² module that displays a single camera from a [SecurityLuxHub](../../hub/)
on your mirror. Pure browser-side — no `node_helper`, no embedded server, no
npm dependencies. It just polls the hub's HTTP API and renders an MJPEG
`<img>` plus a small status row.

## Install

The hub must already be running somewhere reachable on your LAN — see
[`../../hub/README.md`](../../hub/README.md). Then on the MagicMirror Pi:

```bash
git clone https://github.com/JaredLodwick/SecurityLux.git ~/SecurityLux
cd ~/SecurityLux
./mm_module/install.sh
```

That symlinks `~/MagicMirror/modules/MMM-SecurityLuxDisplay` to this directory.
No `npm install` step — there are no module-side deps. The installer also
updates `~/MagicMirror/config/config.js` after asking for the hub URL, camera
ID, and MagicMirror position. It backs up the previous config as
`config.js.securitylux.bak.*`.

Restart MagicMirror. The module will start polling the hub.

## Configuration

| Option                | Default                       | Notes |
|-----------------------|-------------------------------|-------|
| `hubUrl`              | `http://meer.local:5000`      | SecurityLuxHub base URL. |
| `camId`               | `front`                       | Identifier used by the camera_node publisher. |
| `pollMs`              | `500`                         | How often to poll `GET /cam/<id>/status`. Matches the default detector tick rate. |
| `hideWhenOff`         | `true`                        | Hide the module entirely when the feed is off. |
| `showToggleButton`    | `false`                       | Show a Turn ON/OFF button under the feed. |
| `showStatusBar`       | `true`                        | Show the bottom row (detection chip + state + battery). |
| `width`               | `320px`                       | Width of the module. |
| `title`               | `Security Lux`                    | Header text. Empty string hides it. |
| `streamRefreshSeconds`| `300`                         | Periodic MJPEG refresh as a fallback against silent drops. |
| `staleFrameMs`        | `10000`                       | Threshold on hub's `last_frame_age_ms` for triggering a refresh. |
| `errorRetryMs`        | `1500`                        | How long to wait after an `<img>` error before re-fetching. |

## Behavior

- **Live feed:** while the camera is connected and on, an `<img>` points at
  `${hubUrl}/cam/<camId>/stream.mjpg`.
- **Detection chip + bbox overlay:** when the hub's status reports a fresh
  `current_detection`, a green pulsing "Person detected" chip appears in the
  bottom-left, and a green bounding-box overlay is drawn on top of the live
  feed. The bbox transitions smoothly via CSS.
- **Camera off / offline:** placeholder text replaces the `<img>`. If
  `hideWhenOff: true`, the module disappears entirely.
- **MJPEG drop recovery:** the module periodically refreshes the stream
  (every `streamRefreshSeconds`) and explicitly aborts the previous fetch
  by clearing `<img>.src` first, so the browser doesn't leak connection
  slots over time.

## Notifications

The module accepts these MM2 notifications:

- `SECURITY_LUX_TOGGLE` — flip the feed.
- `SECURITY_LUX_ON` — force the feed on.
- `SECURITY_LUX_OFF` — force the feed off.

## See also

- `../../hub/` — the standalone SecurityLuxHub server
- `../../camera_node/` — the Pi-side WebSocket publisher
- `../../PRD.md` — full architecture
