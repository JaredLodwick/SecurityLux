# MMM-LuxSecurityDisplay

A MagicMirror² module that displays a single camera from a [LuxSecurityHub](../../hub/)
on your mirror. Pure browser-side — no `node_helper`, no embedded server, no
npm dependencies. It just polls the hub's HTTP API and renders an MJPEG
`<img>` plus a small status row.

## Install

The hub must already be running somewhere reachable on your LAN — see
[`../../hub/README.md`](../../hub/README.md). Then on the MagicMirror Pi:

```bash
git clone https://github.com/JaredLodwick/DoorCamera.git ~/DoorCamera
cd ~/DoorCamera
./mm_module/install.sh
```

That symlinks `~/MagicMirror/modules/MMM-LuxSecurityDisplay` to this directory.
No `npm install` step — there are no module-side deps.

Then add an entry to `~/MagicMirror/config/config.js`:

```js
{
  module: "MMM-LuxSecurityDisplay",
  position: "bottom_right",
  config: {
    hubUrl: "http://meer.local:5000",   // wherever your LuxSecurityHub is
    camId: "front",                     // matches camera_node config
    title: "Door Cam"
  }
}
```

Restart MagicMirror. The module will start polling the hub.

## Configuration

| Option                | Default                       | Notes |
|-----------------------|-------------------------------|-------|
| `hubUrl`              | `http://meer.local:5000`      | LuxSecurityHub base URL. |
| `camId`               | `front`                       | Identifier used by the camera_node publisher. |
| `pollMs`              | `500`                         | How often to poll `GET /cam/<id>/status`. Matches the default detector tick rate. |
| `hideWhenOff`         | `true`                        | Hide the module entirely when the feed is off. |
| `showToggleButton`    | `false`                       | Show a Turn ON/OFF button under the feed. |
| `showStatusBar`       | `true`                        | Show the bottom row (detection chip + state + battery). |
| `width`               | `320px`                       | Width of the module. |
| `title`               | `Door Cam`                    | Header text. Empty string hides it. |
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

The module accepts these MM2 notifications (`LUX_*` is the new name; the old
`DOORCAM_*` aliases also work for backwards compatibility):

- `LUX_TOGGLE` — flip the feed.
- `LUX_ON` — force the feed on.
- `LUX_OFF` — force the feed off.

## See also

- `../../hub/` — the standalone LuxSecurityHub server
- `../../camera_node/` — the Pi-side WebSocket publisher
- `../../PRD.md` — full architecture
