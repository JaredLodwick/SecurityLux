# MMM-SecurityLuxDisplay

A MagicMirror² module that displays a single camera from a [SecurityLuxHub](../../hub/)
on your mirror, along with the last thing that happened in front of it. Pure
browser-side — no `node_helper`, no embedded server, no npm dependencies. It
polls the hub's HTTP API and renders a live MJPEG feed, a small status row,
and a plain-English last-event line.

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

| Option                    | Default                  | Notes |
|---------------------------|--------------------------|-------|
| `hubUrl`                  | `http://meer.local:5000` | SecurityLuxHub base URL. |
| `camId`                   | `front`                  | Identifier used by the camera_node publisher. |
| `pollMs`                  | `1000`                   | How often to poll `GET /cam/<id>/status`. |
| `eventPollMs`             | `15000`                  | How often to poll for the last event. |
| `hideWhenOff`             | `true`                   | Hide the module entirely when the feed is off. |
| `showToggleButton`        | `false`                  | Show a Turn ON/OFF button under the feed. |
| `showStatusBar`           | `true`                   | Show the bottom row (behaviour chip + state + battery). |
| `showLastEvent`           | `true`                   | Show the last event's description and relative time. |
| `showLastEventThumbnail`  | `false`                  | Also show a small thumbnail of that event. |
| `lastEventMaxAgeMinutes`  | `120`                    | Hide the last event once it's older than this, so the mirror isn't still advertising yesterday's news. `0` disables the cutoff. |
| `width`                   | `320px`                  | Width of the module. |
| `title`                   | `Security Lux`           | Header text. Empty string hides it. |
| `stallTimeoutMs`          | `6000`                   | How long a frozen picture is tolerated before reconnecting. Raise it on a flaky link. |
| `reconnectBackoffMs`      | `1000`                   | First reconnect delay; doubles up to 15 s. |

> **Removed in v0.4:** `streamRefreshSeconds`, `staleFrameMs`, and
> `errorRetryMs`. The blind refresh timer they configured was the cause of
> the feed blanking out — see below. Leaving them in your `config.js` is
> harmless; they're ignored.

## Behavior

- **Live feed:** while the camera is connected and on, the module renders a
  `StreamKeeper`-managed `<img>` pointed at
  `${hubUrl}/cam/<camId>/stream.mjpg`.
- **Detection chip + bbox overlay:** when the hub reports a fresh
  `current_detection`, a green pulsing chip appears bottom-left naming the
  behaviour ("Dwelling", "Passing"), and a bounding box is drawn over the
  feed. The box transitions smoothly via CSS.
- **Last event:** the most recent event's description and relative
  timestamp, e.g. *"Someone approached the trash room door · 4 min ago"*.
  Hover for the absolute time. Dwelling and loitering events are tinted
  amber.
- **Camera off / offline:** placeholder text replaces the feed. With
  `hideWhenOff: true`, the module disappears entirely.

## Stream reliability

This module used to blank out after three to five minutes, and break when
you locked and unlocked your phone. Both are fixed, and the cause is worth
recording because it was the recovery code itself.

The old version ran a `streamRefreshSeconds: 300` timer that nulled the
`<img>`'s `src` and relied on MagicMirror's `updateDom()` (morphdom) to
apply a new one. morphdom reconciles the *existing* element rather than
inserting the freshly-built one, so the request was never actually
re-issued — and because the old multipart connection was never released, it
also burned one of the browser's ~6 connections per origin each time round.
The five-minute timer *was* the five-minute blackout.

It's now handled by `stream-keeper.js`, which:

- **owns the `<img>` outright**, outside MagicMirror's DOM diffing, so
  re-renders can't disturb the live connection;
- **replaces the element on reconnect**, the only approach that reliably
  frees the connection slot across engines;
- **reconnects on evidence, never on a timer** — `error` and `stalled`
  events, `visibilitychange` (the phone-lock fix), `pageshow` from the
  back/forward cache, and coming back online;
- **detects a wedged decoder** by drawing the image into a 16×16 offscreen
  canvas every two seconds and checksumming it. Frozen pixels while the hub
  reports fresh frames means the fault is local. Nothing else catches this,
  because a stalled decoder fires no events at all.

The stall detector needs to read pixels back across origins, so the `<img>`
is loaded with `crossOrigin="anonymous"`; the hub sends
`Access-Control-Allow-Origin: *` on every response. If readback is ever
blocked the watchdog disables itself and recovery falls back to the event
handlers — degraded, never broken.

`stream-keeper.js` is byte-identical to `hub/web/js/stream-keeper.js`.
It's duplicated rather than loaded from the hub so the mirror can keep
trying to reconnect while the hub is unreachable. `mm_module/install.sh`
re-syncs it on every install, and a hub test fails if the copies drift.

## Notifications

The module accepts these MM2 notifications:

- `SECURITY_LUX_TOGGLE` — flip the feed.
- `SECURITY_LUX_ON` — force the feed on.
- `SECURITY_LUX_OFF` — force the feed off.

## See also

- `../../hub/` — the standalone SecurityLuxHub server
- `../../camera_node/` — the Pi-side WebSocket publisher
- `../../PRD.md` — full architecture
