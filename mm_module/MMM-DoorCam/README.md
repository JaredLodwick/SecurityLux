# MMM-DoorCam

A MagicMirror² module that **also runs the camera hub**. The MagicMirror Pi
is the always-on hub for the smart-home setup; door cameras (and other
low-power devices) connect *out* to it over WebSocket and stream JPEG frames
in. The browser-side module renders one camera's MJPEG feed and exposes a
toggle that the hub forwards down to the camera.

This inverts the older design where each camera ran its own Flask server
that the mirror polled. Now the camera is a thin publisher and the mirror
buffers the latest frame for any number of consumers (the on-mirror UI,
detector workers, recorders, etc.).

## What's in the module

```
MMM-DoorCam/
  MMM-DoorCam.js     # browser-side UI: status, MJPEG <img>, toggle button
  MMM-DoorCam.css
  node_helper.js     # the hub: HTTP+WS server on :5000
  README.md
```

The hub listens on its own port (default `5000`), separate from MagicMirror's
own web server, so the camera traffic isn't subject to MM's `ipWhitelist`.

## Hub endpoints

WebSocket (camera publishers connect here):

- `ws://meer.local:5000/cam/<cam_id>` — binary frames + JSON status messages.
  Hub sends `{"type":"set_state","state":"on"|"off"}` down to the camera.

HTTP (browsers, scripts, other modules):

| Method | Path                          | Purpose |
|--------|-------------------------------|---------|
| GET    | `/healthz`                    | Plain `ok`. |
| GET    | `/cams`                       | JSON list of registered cameras + last-known status. |
| GET    | `/cam/<id>/status`            | Status for one camera. |
| GET    | `/cam/<id>/stream.mjpg`       | Multipart MJPEG stream of the buffered frames. |
| POST   | `/cam/<id>/toggle`            | Body `{"state":"on"\|"off"}` to set, no body to flip. |

CORS is wide-open so any LAN page can drive the hub.

## Configuration

Add an entry to `~/MagicMirror/config/config.js`:

```js
{
  module: "MMM-DoorCam",
  position: "bottom_right",
  config: {
    camId: "front",                       // matches the camera's `camera.id`
    hubUrl: "http://meer.local:5000",     // base URL the browser uses for the MJPEG <img>
    hubPort: 5000,                        // port the node_helper binds to
    startEnabled: false,                  // hub will auto-set this camera "on" at start
    hideWhenOff: false,
    showToggleButton: true,
    showStatusBar: true,
    width: "320px",
    title: "Door Cam"
  }
}
```

| Option            | Default                       | Notes |
|-------------------|-------------------------------|-------|
| `camId`           | `front`                       | Identifier the camera publishes under. |
| `hubUrl`          | `http://meer.local:5000`      | Base URL the browser fetches `/stream.mjpg` from. |
| `hubPort`         | `5000`                        | TCP port the helper binds (HTTP + WS). |
| `startEnabled`    | `false`                       | If true, hub sets desired state to `on` at startup. |
| `hideWhenOff`     | `true`                        | Hide the module entirely when the feed is off. |
| `showToggleButton`| `true`                        | Render the Turn ON / Turn OFF button. |
| `showStatusBar`   | `true`                        | Render the small fps / resolution / battery line. |
| `width`           | `320px`                       | Width of the module. |
| `title`           | `Door Cam`                    | Header text. Empty string hides it. |

If you stack multiple `MMM-DoorCam` instances on one mirror (one per camera),
they all share the same hub — only the first instance's `hubPort` matters.

## Install

```bash
cd ~/MagicMirror/modules/MMM-DoorCam
# `ws` is already in MagicMirror's node_modules; nothing to install.
```

Then add the module entry to `config.js` and restart MagicMirror.

## Notifications

The browser module accepts these MM2 notifications:

- `DOORCAM_TOGGLE` — flip the feed.
- `DOORCAM_ON` — force the feed on.
- `DOORCAM_OFF` — force the feed off.

## Camera side

See the `DoorCamera` repo's `pi_client/` — the Pi runs a small Python
publisher that connects to `ws://meer.local:5000/cam/<id>` and streams
frames + battery status.
