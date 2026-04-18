# Door Cam — Web Viewer

Static HTML/CSS/JS frontend for the Door Cam Raspberry Pi security camera. It
shows a live MJPEG feed, a toggle button for turning the feed on/off, a
connection indicator, and a telemetry bar (fps, resolution, uptime, battery,
camera availability).

No build step, no framework, no `node_modules`. Just three files the browser
loads directly.

## Files

- `index.html` — page structure.
- `app.js` — status polling, toggle handler, DOM updates.
- `styles.css` — dark theme, responsive layout.

## How it's served in production

The Pi Client's Flask app (`pi_client/doorcam/server.py`) serves this folder
directly:

- `GET /` returns `web/index.html`.
- `GET /static/<file>` returns sibling files from this folder (so
  `/static/app.js` and `/static/styles.css` resolve correctly).

In that mode `BACKEND_URL` stays empty — all API calls go to the same origin.

## Preview locally against a Pi (or a mock backend)

1. In one terminal, start the Pi Client:

   ```bash
   cd pi_client
   python -m doorcam
   ```

   It listens on `http://localhost:5000` by default.

2. In another terminal, serve this folder as a static site:

   ```bash
   cd web
   python3 -m http.server 8080
   ```

3. Tell the page where the backend is. Two options:

   - **Easier, no edit:** open `http://localhost:8080` with a snippet that
     sets the global first — you can paste this into your browser console
     before reloading, or add it to a local `dev.html`:

     ```html
     <script>window.DOORCAM_BACKEND_URL = "http://localhost:5000";</script>
     <script src="app.js"></script>
     ```

   - **Edit the file:** in `app.js`, change

     ```js
     const BACKEND_URL = "";
     ```

     to

     ```js
     const BACKEND_URL = "http://localhost:5000";
     // or for the real Pi:
     // const BACKEND_URL = "http://doorcam.local:5000";
     ```

4. Open `http://localhost:8080`. The page loads, polls `/status` every 3
   seconds, and mounts the MJPEG stream when the feed is on.

CORS is already enabled on the backend, so cross-origin dev Just Works.

## Opening the file directly (no server)

You can also open `index.html` straight off disk to inspect the layout. The
page will render, fail to reach any backend, and show the "Cannot reach
camera" panel with a Retry button. That's expected.

## Browser compatibility

- Chrome, Edge, Firefox — MJPEG in `<img>` is natively supported, no
  special handling needed.
- Safari — historically a bit quirky with MJPEG, but renders a continuous
  `multipart/x-mixed-replace` stream correctly in recent versions.
- Mobile browsers on iOS and Android follow their desktop counterparts.

## Notes on implementation choices

- Status polling uses recursive `setTimeout` rather than `setInterval` so a
  slow response can't cause overlapping requests to pile up.
- Polling pauses on `visibilitychange` when the tab is hidden and resumes
  instantly when it comes back, to be polite to a Pi Zero 2 W.
- The MJPEG `<img>` is only mounted when the camera state is `"on"` — when
  off, the placeholder is shown and `src` is not set, so the browser never
  hits `/stream.mjpg` (which would 503).
- Every time the stream is (re)mounted, a `?t=<timestamp>` cache-buster is
  appended so the browser doesn't reuse a stale multipart connection.
- No `localStorage`, `sessionStorage`, cookies, or `IndexedDB` — all state
  lives in memory, per the project's constraints.
