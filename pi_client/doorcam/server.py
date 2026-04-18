"""Flask application and HTTP routes for the Door Cam Pi client.

Exposes the public HTTP contract the frontend and MagicMirror module consume:
``/``, ``/stream.mjpg``, ``/toggle``, ``/status``, ``/healthz``, plus a
``/static/<path>`` passthrough to the sibling ``web/`` folder.

Kept deliberately thin — all camera lifecycle work lives in ``camera.py`` and
all state transitions live in ``state.py``; this file only translates HTTP
requests into calls against those pieces.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Optional

from flask import Flask, Response, jsonify, request, send_from_directory

from .camera import CameraConfig, CameraManager
from .pisugar import PiSugarClient
from .state import CameraState, StateValue

log = logging.getLogger(__name__)

MJPEG_BOUNDARY = "frame"


def _web_dir() -> Path:
    """Return absolute path to the sibling ``web/`` folder.

    Layout:
        <repo-root>/pi_client/doorcam/server.py   <- this file
        <repo-root>/web/                          <- frontend agent owns this
    """
    here = Path(__file__).resolve()
    return (here.parent.parent.parent / "web").resolve()


def create_app(config: dict[str, Any]) -> Flask:
    """Build and return a configured Flask app.

    Splitting construction into a factory keeps the module import-safe (no side
    effects on import) and gives tests a way to inject a custom config.
    """
    # static_folder=None disables Flask's default /static handler (which would
    # look inside the doorcam package). We expose our own /static/<path> route
    # below that serves the sibling web/ directory.
    app = Flask(__name__, static_folder=None)

    cam_cfg = CameraConfig(
        device=str(config["camera"]["device"]),
        width=int(config["camera"]["resolution"][0]),
        height=int(config["camera"]["resolution"][1]),
        fps=int(config["camera"]["fps"]),
        jpeg_quality=int(config["camera"]["jpeg_quality"]),
    )
    initial_state: StateValue = (
        "on" if str(config["feed"]["start_state"]).lower() == "on" else "off"
    )
    state = CameraState(initial=initial_state)
    camera = CameraManager(cam_cfg, state)
    camera.start_if_on()

    pisugar = PiSugarClient(
        host=str(config["pisugar"]["host"]),
        port=int(config["pisugar"]["port"]),
        timeout=float(config["pisugar"]["timeout_seconds"]),
    )

    start_time = time.monotonic()
    web_dir = _web_dir()

    # Expose collaborators on the app object for tests + shutdown.
    app.config["DOORCAM_STATE"] = state
    app.config["DOORCAM_CAMERA"] = camera
    app.config["DOORCAM_PISUGAR"] = pisugar
    app.config["DOORCAM_CAMERA_CFG"] = cam_cfg
    app.config["DOORCAM_START_TIME"] = start_time
    app.config["DOORCAM_WEB_DIR"] = web_dir

    # Hand-rolled CORS: the web UI may be served from a different origin during
    # development (e.g. a file:// viewer or a live-reload server). flask-cors is
    # listed in requirements.txt as an acceptable alternative; a response hook
    # keeps the dependency surface smaller.
    @app.after_request
    def add_cors_headers(response: Response) -> Response:
        response.headers.setdefault("Access-Control-Allow-Origin", "*")
        response.headers.setdefault(
            "Access-Control-Allow-Methods", "GET, POST, OPTIONS"
        )
        response.headers.setdefault(
            "Access-Control-Allow-Headers", "Content-Type"
        )
        return response

    # --- routes -------------------------------------------------------------

    @app.route("/", methods=["GET"])
    def index() -> Response:
        index_html = web_dir / "index.html"
        if index_html.is_file():
            return send_from_directory(str(web_dir), "index.html")
        placeholder = (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<title>Door Cam</title></head><body>"
            "<h1>Door Cam backend is running.</h1>"
            "<p>Frontend not deployed.</p>"
            "<p><a href='/status'>/status</a></p>"
            "</body></html>"
        )
        return Response(placeholder, mimetype="text/html")

    @app.route("/static/<path:filename>", methods=["GET"])
    def static_passthrough(filename: str) -> Response:
        return send_from_directory(str(web_dir), filename)

    @app.route("/healthz", methods=["GET"])
    def healthz() -> Response:
        return Response("ok", mimetype="text/plain")

    @app.route("/stream.mjpg", methods=["GET"])
    def stream_mjpg() -> Response:
        if state.get() != "on":
            return (
                jsonify({"error": "feed is off"}),
                503,
                {"Content-Type": "application/json"},
            )

        def generate():
            # Hold at most one frame's worth of bytes in memory per client.
            # Last-writer-wins from the camera means slow clients miss frames
            # rather than causing server-side memory growth.
            last_jpeg: Optional[bytes] = None
            while state.get() == "on":
                jpeg = camera.get_latest_jpeg(wait_seconds=1.0)
                if jpeg is None:
                    continue
                if jpeg is last_jpeg:
                    # Nothing new; don't spin the CPU re-sending the same bytes.
                    time.sleep(0.01)
                    continue
                last_jpeg = jpeg
                yield (
                    b"--" + MJPEG_BOUNDARY.encode("ascii") + b"\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(jpeg)).encode("ascii") + b"\r\n\r\n"
                    + jpeg + b"\r\n"
                )

        return Response(
            generate(),
            mimetype=f"multipart/x-mixed-replace; boundary={MJPEG_BOUNDARY}",
        )

    @app.route("/toggle", methods=["POST", "OPTIONS"])
    def toggle() -> Response:
        if request.method == "OPTIONS":
            return Response(status=204)
        payload = request.get_json(silent=True)
        if isinstance(payload, dict) and "state" in payload:
            requested = str(payload["state"]).lower()
            if requested not in ("on", "off"):
                return (
                    jsonify({"error": "state must be 'on' or 'off'"}),
                    400,
                )
            new_state = state.set(requested)  # type: ignore[arg-type]
        else:
            new_state = state.toggle()
        return jsonify({"state": new_state})

    @app.route("/status", methods=["GET"])
    def status() -> Response:
        uptime = int(time.monotonic() - start_time)
        battery_pct = pisugar.get_battery()
        charging = pisugar.get_charging()
        on_battery: Optional[bool]
        if charging is None:
            on_battery = None
        else:
            on_battery = not charging
        body: dict[str, Any] = {
            "state": state.get(),
            "uptime_seconds": uptime,
            "fps": int(cam_cfg.fps),
            "resolution": camera.resolution_str,
            "battery_pct": battery_pct,
            "on_battery": on_battery,
            "camera_available": camera.is_available(),
        }
        return jsonify(body)

    return app


def run_from_env() -> None:
    """Entry point used by ``python -m doorcam``."""
    from .config import load_config

    config = load_config()
    log_level = str(config["logging"]["level"]).upper()
    logging.basicConfig(
        level=getattr(logging, log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app = create_app(config)
    host = str(config["server"]["host"])
    port = int(config["server"]["port"])
    log.info("Starting Door Cam server on %s:%s", host, port)
    # threaded=True so /status, /toggle, and /stream.mjpg can all be served
    # concurrently. The capture itself runs in its own background thread.
    app.run(host=host, port=port, threaded=True, use_reloader=False)


# Allow running the module directly for quick dev sanity checks without the
# package wrapper, though ``python -m doorcam`` is the documented entry.
if __name__ == "__main__":  # pragma: no cover
    run_from_env()
