# SecurityLux — MVP Completion Plan

**Status:** ✅ implemented (2026-07-25). Kept as the design record — the rationale
behind each decision is here rather than scattered through commit messages.
**Created:** 2026-07-25
**Target:** close out Phase 2 (event capture + storage), Phase 3, and Phase 4 (profiles),
plus the LED, remote camera control, and the MJPEG blackout bug.

Deadbolt / lock actuation (Phase 5 hardware) is explicitly **out of scope**.

> **What shipped vs. what was planned.** Everything below was built, with one
> deliberate reduction agreed during the work: face recognition is *scaffolded*
> rather than finished (§10). Profiles, clearances, enrollment, sample storage,
> and the matching maths are all complete and tested; only the embedding step is
> stubbed, because it needs two ONNX models published to a GitHub release. The
> system is fully functional with it off, which is the default.
>
> Four real bugs were caught by the tests written alongside the code, and are
> worth recording because none would have been obvious in review:
>
> 1. **Track association radius was too tight.** A fixed 0.28-of-frame-width
>    match distance fragments a briskly-walking person into several one-tick
>    tracks at a 2 Hz detector rate, which destroys dwell time and makes
>    "walked past" indistinguishable from "stood there". Now scaled by elapsed
>    time (`tracker.js`).
> 2. **Presence was derived from open tracks, not detections.** Tracks
>    deliberately survive a few missed ticks; treating that as presence
>    refreshed the grace timer on every empty frame, so *every* recording would
>    have run to the 5-minute maximum length instead of ending when the person
>    left (`session.js`).
> 3. **A missing ffmpeg crashed the hub.** `spawn` reports ENOENT via an async
>    `error` event, not a throw. With no handler attached, a hub without ffmpeg
>    would die on the first detection rather than logging the event without a
>    clip (`recorder.js`).
> 4. **`port: 0` silently became port 5000.** `(cfg.hub.port) || 5000` treats a
>    legitimate request for an ephemeral port as falsy (`server.js`). The same
>    falsy-zero mistake appeared in two other places and was fixed there too.

---

## 0. Decisions locked in

| Decision | Choice | Why |
|---|---|---|
| NeoPixel location | Camera Pi, **SPI (GPIO10 / MOSI)** | No root needed (`adafruit-circuitpython-neopixel-spi`), no audio conflict, light is physically at the door |
| Event descriptions | **Local template engine only** | Deterministic, offline, preserves the LAN-only guarantee. Driven by user-named zones + scene guidance |
| Face recognition | **Profiles + enrollment first, recognition last** | Everything else ships even if the face pipeline runs long |
| Hub hardware | **Pi 4 (4–8 GB)** | Enough headroom for libx264 + face embeddings alongside YOLO |

---

## 1. The three biggest structural changes

Everything below depends on these. They come first.

### 1.1 Recording codec: switch default from MJPEG-copy to h264

Today `recording.codec: mkv` stream-copies raw MJPEG into a Matroska container.
Zero CPU, but the file size is brutal:

| Codec | Bitrate @ 640×480/15fps | Per minute | 40 GB of clips buys you |
|---|---|---|---|
| MJPEG copy (current default) | ~3.6 Mbps | **~27 MB** | ~25 hours |
| h264 ultrafast crf28 | ~0.3 Mbps | **~2 MB** | **~330 hours** |

On a Pi 4, libx264 `ultrafast` at 640×480/15fps costs roughly 10% of one core per
camera. That is a trivially good trade for a **~13× storage win**, and it also
fixes the dashboard's existing "your browser couldn't decode this clip" fallback
path, since mp4/h264 plays natively everywhere including iOS Safari.

**Change:** `recording.codec` defaults to `h264` (mp4). MJPEG-copy stays available
for anyone running the hub on weak hardware.

### 1.2 The store must open at hub boot, not at detection boot

Right now `Store` is only constructed inside `_bootDetection()`. That made sense when
the DB held nothing but detection events. It now needs to hold **settings, zones,
profiles, and face samples** — all of which must work with detection switched off.

**Change:** `HubServer.start()` opens the store unconditionally. Detection boot stops
owning it. This also removes the confusing 503 "events store unavailable" state from
the dashboard.

### 1.3 Settings move from YAML-only to YAML-defaults + DB-overrides

The UI needs to write settings. `config.yml` is read once at boot and never written.

**Change:** a `settings` table in SQLite holds user overrides; `config.yml` becomes the
bootstrap default layer. Resolution order: **built-in defaults → config.yml → DB → per-camera override**.
A single `SettingsService` owns this merge and notifies subscribers (recorder, detector,
sweeper) on change so edits apply without a hub restart.

---

## 2. Phase A — Fix the stream blackout

**The bug.** `MMM-SecurityLuxDisplay` has `streamRefreshSeconds: 300`. That is exactly
your "~3 to 5 minutes." `_refreshStreamSrc()` nulls the old `<img>`'s `src` and bumps a
nonce, then relies on MagicMirror's `updateDom()` → morphdom to patch the new `src` onto
a freshly-built `<img>`. morphdom reconciles the *old* element rather than inserting the
new one, and the re-issued `src` doesn't reliably re-open the multipart connection — so
the refresh intended as a safety net is what kills the feed. Status keeps polling fine,
which is why battery still updates over a black frame.

The mobile case is the same failure with a different trigger: locking the phone suspends
the page, Chrome/Safari tears down the multipart connection, and nothing ever reconnects
it — hence the broken-image icon until you manually refresh.

**Fix — a shared `StreamKeeper`** (`hub/web/stream-keeper.js`, copied into the MM module
so it stays dependency-free):

1. **Own the `<img>` outright.** Create it once, hold the reference, never let a DOM
   differ touch it. Refreshes swap `src` on the element we hold.
2. **Hard teardown before reconnect.** `img.removeAttribute('src')` → force layout →
   assign new URL with a fresh nonce. This is what actually releases the browser's
   per-origin connection slot (you get ~6; leaked MJPEG sockets exhaust it fast).
3. **`visibilitychange` handler.** On `visible`, immediately reconnect. Fixes phone-lock.
4. **Real stall detector.** Every 2s, draw the `<img>` into a 16×16 offscreen canvas and
   checksum it. If the checksum is unchanged for `stallTimeoutMs` (default 6s) *while*
   `/status` reports `last_frame_age_ms` is small, the pixels are frozen even though the
   server is live → reconnect. This catches silent decoder death, which no `error` event
   ever fires for.
5. **`error` / `stalled` listeners** with exponential backoff (1s → 15s).
6. **Drop the blind periodic refresh entirely.** Reconnect on evidence, not on a timer.

**Server-side support:**
- `GET /cam/<id>/snapshot.jpg` — the latest buffered frame as a single JPEG. Used as the
  stall-detector's cross-check, as the grid thumbnail source at >4 cameras, and as a
  graceful degradation path.
- MJPEG responses get a periodic comment part when no new frame is available, so
  intermediaries and the browser see the connection as alive rather than idle-timing-out.

**Applies to both** the hub dashboard (`hub/web/index.html`, `updateCamCardFrame`) and the
MM module. Same code, same behavior.

---

## 3. Phase B — Event capture with pre/post-roll

This is the Phase 2 gap. Today `Recorder.start()` is called *at the moment of detection*,
so the clip begins with the person already mid-frame. You asked for 5 seconds before and
5 seconds after. That requires buffering frames the hub has already thrown away.

### 3.1 Per-camera ring buffer

New `hub/src/framebuffer.js`. Fixed-capacity circular buffer of `{jpeg, ts, seq}` sized by
`recording.preRollSeconds × camera fps`, with a hard byte ceiling.

Cost at 640×480/q70/15fps: ~30 KB/frame × 15 × 5s ≈ **2.3 MB per camera**. Negligible.

`HubServer.onCamSocket` pushes every inbound frame into it — this replaces the current
single `lastJpeg` slot (which stays as a pointer to the newest entry so nothing else
changes).

### 3.2 Session lifecycle, corrected

```
person detected ──► write ring buffer (pre-roll) into ffmpeg, then live frames
                    insert event row, generate thumbnail
person gone ──────► grace window (1.5s, unchanged — this decides "is it over")
grace expired ────► session ends logically; recorder KEEPS RUNNING for postRollSeconds
post-roll done ───► ffmpeg stdin closed, row finalized with real clip path
```

The key correction: **logical session end and recorder stop are decoupled.** Right now
`_endSession` awaits `recorder.stop()` immediately. The recorder gets its own small state
machine so post-roll doesn't block the event row from finalizing.

### 3.3 Thumbnails

At session start, take the middle pre-roll frame and write
`<clipsRoot>/<date>/<time>_<cam>_person.jpg` (~10 KB via `sharp`). Served at
`GET /events/<id>/thumb.jpg`. Makes the events list scannable instead of a wall of text.

### 3.4 New/changed config

```yaml
recording:
  codec: h264            # CHANGED default (was mkv)
  crf: 28                # NEW — quality knob for h264
  preRollSeconds: 5      # NEW
  postRollSeconds: 5     # NEW
  thumbnails: true       # NEW
```

---

## 4. Phase C — Storage management

Your stated worry, and correctly so: a 64 GB card with no ceiling fills silently and then
the hub starts failing writes.

### 4.1 Three independent limits, all enforced

| Limit | Default | Behavior when hit |
|---|---|---|
| `retentionDays` | 14 | Delete events + clips older than N days |
| `maxTotalGB` | 16 | Delete **oldest clips first** until under budget. Event rows survive with `clip_pruned: true` — you keep the log, you lose the video |
| `minFreeGB` | 4 | Hard floor on the filesystem. Below it: aggressively prune, and if still below, **stop recording new clips** while continuing to log events. Surfaced as a dashboard banner |

The sweeper runs every 15 minutes (down from 6 hours — too coarse to protect a small card)
and additionally right after every clip finalizes.

### 4.2 Storage API + UI

- `GET /storage` → `{ totalBytes, freeBytes, clipsBytes, byCam: {...}, oldestClipMs, eventCount, projectedDaysRemaining, recordingPaused, pausedReason }`
- `POST /storage/prune` → manual sweep, returns what it removed
- New **Storage** page in the dashboard: usage bar, per-camera breakdown, projected
  runway at current event rate, the three limits as live-editable controls, and a
  "prune now" button with a confirmation step.

### 4.3 Per-camera overrides

`recordingEnabled`, `retentionDays`, `codec`, `preRoll`/`postRoll` can each be overridden
per camera from that camera's settings panel. A low-traffic porch cam and a busy front
door don't need the same policy.

---

## 5. Phase D — Zones, tracking, and natural-language descriptions

This is what turns "person detected, 12s, 87% confidence" into
*"Someone walked up to the trash room door and stood there for 12 seconds."*

### 5.1 Named zones

Per camera, you draw rectangles/polygons on a live snapshot in the web UI and label them.
Each zone carries:

- `name` — "Trash room door", "Driveway", "Walkway", "Neighbor's steps"
- `kind` — `door` | `path` | `area` | `ignore`
- `verbs` — how the describer talks about it: entered/left/approached/passed
- `ignore` zones suppress detection entirely inside them (kills the recurring
  false-positive from a swaying branch or a neighbor's window)

Stored as JSON in the DB, editable at `GET/PUT /cam/<id>/zones`.

### 5.2 Scene guidance

Free-text per camera (`"Front door. The door on the left is the trash room. The
driveway is on the right. The sidewalk at the top of frame is public."`) plus structured
fields: camera friendly name, what it faces, indoor/outdoor. This is the "guidance" you
described. The template engine consumes the structured parts; the free text is stored and
shown in the UI, and is the natural hook if you ever turn on an LLM describer.

### 5.3 Lightweight tracker

The detector currently reports only the first person box per frame. Extend it to return
**all** person boxes, and add a centroid tracker in `hub/src/tracker.js`:

- Greedy nearest-centroid association across ticks (2 fps is plenty for walking pace)
- Per-track: entry zone, exit zone, zone dwell times, path, total displacement, peak
  confidence, first/last seen

From the track we derive a **behavior classification**, which drives both the description
and the LED:

| Class | Condition |
|---|---|
| `passing` | Track crosses frame, total dwell < 3s, displacement > 40% of frame width |
| `approaching` | Bbox area growing steadily, heading toward a `door` zone |
| `present` | In frame ≥ 3s |
| `dwelling` | In frame ≥ 10s with low centroid variance |
| `loitering` | In frame ≥ 30s |

### 5.4 Describer

`hub/src/describe.js` — a pure function `(event, track, zones, camera) → string`.
Deterministic, unit-testable, no I/O. Composes from slot templates:

> `{subject} {verb} {zone} {qualifier} {duration}`
> → "Someone approached the trash room door and stood there for 12 seconds."
> → "Someone passed by the front door heading toward the driveway."
> → "Someone was at the front door for 4 minutes." *(loitering)*
> → "Jared arrived at the front door." *(once recognition lands)*

Time-of-day qualifiers ("after dark", "early this morning") come from sunrise/sunset
computed from a configured lat/long — no network call.

The description is written to a new `events.description` column at finalize time, and is
regenerable via `POST /events/<id>/redescribe` after you edit zones (so relabeling a zone
fixes historical events instead of leaving them stale).

---

## 6. Phase E — NeoPixel door light

### 6.1 Wiring (SPI, no root)

```
NeoPixel DIN  ──► Pi GPIO10 / MOSI (physical pin 19)
NeoPixel GND  ──► Pi GND (physical pin 6)  [common ground is mandatory]
NeoPixel 5V   ──► 5V supply
```

`sudo raspi-config` → Interface Options → SPI → enable. Add
`core_freq_min=500` to `/boot/firmware/config.txt` so SPI clock doesn't drift with CPU
scaling and corrupt the WS2812 timing.

8 LEDs at full white draw ~480 mA. **Do not** run that off the Pi Zero's 5V rail while
the PiSugar is also charging — the plan caps default brightness at 40% and documents a
separate 5V feed for anything higher.

New dep: `adafruit-circuitpython-neopixel-spi` (+ `adafruit-blinka`). Guarded import —
if the library or hardware is missing, `LedController` degrades to a no-op that logs once.
Camera nodes without a strip are unaffected.

### 6.2 Protocol

Hub → camera, over the existing WebSocket:

```json
{"type":"led","pattern":"dwell","stage":3,"color":[255,170,0],"brightness":0.4,"ttlMs":5000}
```

**`ttlMs` is the important field.** The camera decays back to idle if it doesn't hear
from the hub within the TTL. If the hub crashes mid-event, the porch light doesn't stay
stuck on all night.

The camera owns animation timing locally (a small asyncio task), so a WiFi hiccup produces
a smooth fade rather than a stutter.

### 6.3 Patterns — escalating intensity

| Stage | Trigger | Animation |
|---|---|---|
| 0 idle | no person | off (or optional dim always-on nightlight) |
| 1 passing | `passing` classification | single cyan sweep across the strip, ~1.5s, then fade |
| 2 present | person ≥ 3s | soft warm-white breathe, slow |
| 3 dwelling | person ≥ 10s, low movement | brighter amber pulse, faster |
| 4 loitering | person ≥ 30s | bright amber/red alternating chase |

Every threshold, color, brightness cap, and enable/disable is editable per camera in the
web UI. Includes a **"Test pattern"** button (`POST /cam/<id>/led/test`) so you can verify
wiring without standing in front of the door.

**Bonus worth taking:** an `illuminateOnEvent` option that drives the strip to bright white
during a night event. Free IR-illuminator substitute — it measurably improves what the
camera and the detector can see after dark.

---

## 7. Phase F — Remote camera control

Two new WS commands, both gated behind a confirmation dialog in the UI:

| Endpoint | WS message | Camera action |
|---|---|---|
| `POST /cam/<id>/restart` | `{"type":"restart_service"}` | Publisher exits cleanly; systemd `Restart=on-failure` brings it back in ~2s. **This is the one to reach for first** — fixes 95% of camera weirdness without a 40s boot |
| `POST /cam/<id>/reboot` | `{"type":"reboot"}` | `sudo systemctl reboot` |

Reboot needs a narrow sudoers rule installed by `camera_node/install.sh`:

```
camnode ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
```

Scoped to exactly that one command — not blanket NOPASSWD.

The UI shows a per-camera "last seen / uptime / reconnect count" strip so you can tell
whether a reboot actually helped.

---

## 8. Phase G — Web portal

### 8.1 Events

The existing list gets: thumbnails, the natural-language description as the primary line,
filters (camera / date range / type / behavior class / profile), infinite scroll, and a
delete-event action. Per-camera view already filters server-side — that part is scaffolded
as you thought.

### 8.2 Settings

New section, three tabs:
- **Storage** — the limits from §4, usage visualization, prune
- **Recording** — codec, quality, pre/post-roll, min/max clip length
- **Detection** — global + per-camera, confidence threshold, detector fps

### 8.3 Per-camera panel

Feed, on/off, detection toggle, restart/reboot, zone editor (draw on live snapshot),
scene guidance text, LED config + test, per-camera storage overrides, and that camera's
event log.

### 8.4 Profiles

Full CRUD: name, clearance level (0–3), notes, face samples as a thumbnail grid.
Two enrollment paths — upload photos, or **"add this face to a profile" directly from an
event thumbnail**, which is by far the path you'll actually use. Auto-created anonymous
profiles ("Unknown #3, seen 7 times") that you can promote to a named profile in one click.

---

## 9. Phase H — MagicMirror module

- StreamKeeper from Phase A (fixes the blackout)
- **Last event display**: description + relative timestamp ("Someone approached the trash
  room door · 4 min ago"), fed by a new `GET /events/latest?cam=<id>`, with the absolute
  time on hover
- Optional thumbnail of that last event
- New config: `showLastEvent`, `lastEventMaxAgeMinutes` (hide stale events so the mirror
  isn't advertising yesterday's news)

---

## 10. Phase I — Face recognition (last)

Sequenced last deliberately. Everything above ships whether or not this lands.

Two small ONNX models in the existing detector worker (`onnxruntime-node` + `sharp` are
already dependencies, so no new native deps):

1. **SCRFD-500m** (~2.5 MB) — face detection + 5-point landmarks
2. **MobileFaceNet / ArcFace** (~4 MB) — 512-d embedding

Pipeline: person box → face detect → align via landmarks → embed → cosine-similarity
match against enrolled embeddings (`face_samples` table, BLOB embeddings) → emit
`known_face:<profile>` or `unknown_face`. Unknown embeddings cluster into auto-profiles
after N sightings.

Runs only on frames that already have a person, at ≤1 fps, so it adds maybe 15% CPU on a
Pi 4 rather than doubling load.

**Risk to flag:** the model files need hosting. The repo already uses the
`github.com/JaredLodwick/SecurityLux/releases/download/models-v1/` pattern for
yolov8n-int8 — I'll extend that release, but it needs your GitHub account to publish.

---

## 11. Answering "anything I'm missing?"

Things a standard-yet-capable system has that aren't on your list. My recommendations:

**Take these — they're cheap and you'll miss them immediately:**

1. **Motion pre-filter before YOLO.** Cheap frame-differencing gate so YOLO only runs when
   pixels actually changed. Cuts idle hub CPU by ~80% and lets you *raise* detector fps
   during real activity — better detection *and* less load. Maybe 60 lines.
2. **Camera-offline alerting.** Right now a dead camera is silent. If a camera stops
   reporting for N minutes, log a `camera_offline` event and surface it in the UI. This is
   the single most valuable alert a security system has — a camera that's been down for
   three days is worse than no camera, because you *think* you're covered.
3. **Event thumbnails** (already in §3.3) — a text-only event list is nearly unusable at
   scale.
4. **Clock sanity check.** A Pi with a dead RTC that boots before NTP syncs writes events
   timestamped 1970. Refuse to write events until the clock is sane, and warn in the UI.
5. **`events.db` backup.** Nightly `VACUUM INTO` a dated copy, keep 7. The DB is the
   irreplaceable part — clips are re-recordable, your profile enrollments aren't.

**Take this one if you'll ever expose the hub beyond the LAN:**

6. **Optional auth.** The PRD's "trusted LAN, no auth" is a defensible choice *today*, but
   the moment there's a port-forward or a VPN guest, every camera in the house is an open
   MJPEG endpoint. I'd add an optional shared-secret token — off by default, one config
   line to turn on, covering both the HTTP surface and the camera WS hello. Cheap
   insurance, no cost while it's off.

**Deliberately deferring — say the word if you want them:**

7. **Push notifications.** A generic outbound webhook on event creation would take ~30
   lines and lets you wire up ntfy/Pushover/Home Assistant yourself. Full push
   integration is its own project.
8. **Two-way audio, sirens, PTZ** — no hardware for it.
9. **Off-LAN access** — explicit PRD non-goal.

---

## 12. Sequencing and risk

Ordered so that each phase is independently shippable and the risky work is last.

| # | Phase | Risk | Notes |
|---|---|---|---|
| 1 | A — stream fix | Low | Highest daily value; unblocks trusting the system |
| 2 | 1.2/1.3 — store + settings refactor | Medium | Touches boot path; everything downstream needs it |
| 3 | B — pre/post-roll + h264 + thumbs | Low | Closes the Phase 2 gap |
| 4 | C — storage management | Low | Protects the card before we start generating real volume |
| 5 | F — restart/reboot | Low | Small, self-contained |
| 6 | D — zones + tracker + describer | Medium | The most *design*-heavy piece |
| 7 | E — NeoPixel | Medium | Only phase with a hardware dependency I can't test from here |
| 8 | G — web portal | Medium | Large surface area, low individual risk |
| 9 | H — MM module | Low | |
| 10 | I — face recognition | **High** | Needs model hosting; explicitly last |

**What I can't verify from this machine:** anything touching the actual Pis. NeoPixel
timing, the sudoers reboot path, real h264 CPU load on your hub, and end-to-end MJPEG
behavior on the MagicMirror all need testing on hardware. I'll write them defensively and
flag each one for you to confirm.

**Testing:** unit tests alongside each phase per the repo's standard — describer, tracker,
zones, framebuffer, settings merge, and storage sweeper are all pure logic and get real
coverage. The hardware-adjacent paths (LED, reboot, ffmpeg) get interface tests with
injected fakes, matching how `SessionManager` already takes a `recorderFactory`.

---

## 13. PRD updates this implies

- §2 non-goals: drop "no recording, clip storage, or event timelines"
- §5: add F11–F20 (zones, descriptions, LED, remote control, storage policy, profiles)
- §8: document the ~15 new endpoints
- §13: M8 partial → done; add M11 (event capture), M12 (storage), M13 (zones/descriptions),
  M14 (LED), M15 (profiles)
- §12: `adafruit-circuitpython-neopixel-spi` on the camera; no new hub deps
