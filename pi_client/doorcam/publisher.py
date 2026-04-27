"""WebSocket publisher — pushes frames and status to the MagicMirror hub.

The Pi camera is a low-power node; the always-on Mirror Pi is the hub. This
module connects out to ``ws://<hub>/cam/<cam_id>``, sends:

  * binary JPEG frames while the camera is on (last-writer-wins, fps-capped)
  * text JSON status messages every few seconds (battery, fps, resolution)

and listens for control messages from the hub:

  * ``{"type": "set_state", "state": "on" | "off"}`` → drives the local
    ``CameraState`` so ``CameraManager`` opens or releases the device.

All hardware ownership stays in ``camera.py`` / ``state.py`` / ``pisugar.py``
exactly as before — this file is purely the network adapter.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import Any, Optional
from urllib.parse import quote

import websockets
from websockets.exceptions import ConnectionClosed

from .camera import CameraConfig, CameraManager
from .pisugar import PiSugarClient
from .state import CameraState, StateValue

log = logging.getLogger(__name__)

STATUS_INTERVAL_SECONDS = 5.0
RECONNECT_BACKOFF_INITIAL = 1.0
RECONNECT_BACKOFF_MAX = 30.0


class Publisher:
    """Owns the WS connection lifecycle and the frame/status pumps."""

    def __init__(
        self,
        hub_url: str,
        cam_id: str,
        camera: CameraManager,
        state: CameraState,
        pisugar: PiSugarClient,
        cam_cfg: CameraConfig,
    ) -> None:
        self.hub_url = hub_url.rstrip("/")
        self.cam_id = cam_id
        self.camera = camera
        self.state = state
        self.pisugar = pisugar
        self.cam_cfg = cam_cfg

    @property
    def endpoint(self) -> str:
        return f"{self.hub_url}/cam/{quote(self.cam_id, safe='')}"

    async def run(self) -> None:
        """Connect-loop with exponential backoff. Returns only on cancellation."""
        backoff = RECONNECT_BACKOFF_INITIAL
        while True:
            try:
                log.info("Connecting to hub at %s", self.endpoint)
                async with websockets.connect(
                    self.endpoint,
                    max_size=4 * 1024 * 1024,
                    ping_interval=20,
                    ping_timeout=20,
                ) as ws:
                    backoff = RECONNECT_BACKOFF_INITIAL
                    await self._session(ws)
            except (OSError, ConnectionClosed, asyncio.TimeoutError) as exc:
                log.warning("Hub connection failed/closed: %s", exc)
            except Exception:
                log.exception("Unexpected error in publisher session")

            self.state.set("off")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)

    async def _session(self, ws: websockets.WebSocketClientProtocol) -> None:
        await ws.send(json.dumps({
            "type": "hello",
            "cam_id": self.cam_id,
            "capabilities": {
                "fps": int(self.cam_cfg.fps),
                "resolution": f"{self.cam_cfg.width}x{self.cam_cfg.height}",
                "jpeg_quality": int(self.cam_cfg.jpeg_quality),
            },
        }))

        recv_task = asyncio.create_task(self._receive_loop(ws))
        frame_task = asyncio.create_task(self._frame_loop(ws))
        status_task = asyncio.create_task(self._status_loop(ws))
        try:
            done, pending = await asyncio.wait(
                {recv_task, frame_task, status_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            for task in pending:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
            for task in done:
                exc = task.exception()
                if exc:
                    raise exc
        finally:
            for task in (recv_task, frame_task, status_task):
                if not task.done():
                    task.cancel()

    async def _receive_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        async for raw in ws:
            if isinstance(raw, bytes):
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("Ignoring non-JSON text message from hub")
                continue
            if not isinstance(msg, dict):
                continue
            mtype = msg.get("type")
            if mtype == "set_state":
                desired = msg.get("state")
                if desired in ("on", "off"):
                    log.info("Hub requested state=%s", desired)
                    self.state.set(desired)  # type: ignore[arg-type]

    async def _frame_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        last_jpeg: Optional[bytes] = None
        frame_interval = 1.0 / max(int(self.cam_cfg.fps), 1)
        while True:
            if self.state.get() != "on":
                await asyncio.sleep(0.1)
                continue
            jpeg = await asyncio.to_thread(self.camera.get_latest_jpeg, 1.0)
            if jpeg is None or jpeg is last_jpeg:
                await asyncio.sleep(0.01)
                continue
            last_jpeg = jpeg
            await ws.send(jpeg)
            await asyncio.sleep(frame_interval)

    async def _status_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        while True:
            payload = await asyncio.to_thread(self._collect_status)
            await ws.send(json.dumps(payload))
            await asyncio.sleep(STATUS_INTERVAL_SECONDS)

    def _collect_status(self) -> dict[str, Any]:
        battery_pct = self.pisugar.get_battery()
        charging = self.pisugar.get_charging()
        on_battery: Optional[bool]
        if charging is None:
            on_battery = None
        else:
            on_battery = not charging
        local_state: StateValue = self.state.get()
        return {
            "type": "status",
            "cam_id": self.cam_id,
            "state": local_state,
            "fps": int(self.cam_cfg.fps),
            "resolution": self.camera.resolution_str,
            "battery_pct": battery_pct,
            "on_battery": on_battery,
            "camera_available": self.camera.is_available(),
        }


def run_from_env() -> None:
    """Entry point used by ``python -m doorcam``."""
    from .config import load_config

    config = load_config()
    log_level = str(config["logging"]["level"]).upper()
    logging.basicConfig(
        level=getattr(logging, log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    cam_cfg = CameraConfig(
        device=str(config["camera"]["device"]),
        width=int(config["camera"]["resolution"][0]),
        height=int(config["camera"]["resolution"][1]),
        fps=int(config["camera"]["fps"]),
        jpeg_quality=int(config["camera"]["jpeg_quality"]),
    )
    cam_id = str(config["camera"]["id"])
    state = CameraState(initial="off")
    camera = CameraManager(cam_cfg, state)
    pisugar = PiSugarClient(
        host=str(config["pisugar"]["host"]),
        port=int(config["pisugar"]["port"]),
        timeout=float(config["pisugar"]["timeout_seconds"]),
    )
    hub_url = str(config["hub"]["url"])

    publisher = Publisher(hub_url, cam_id, camera, state, pisugar, cam_cfg)

    try:
        asyncio.run(publisher.run())
    except KeyboardInterrupt:
        log.info("Shutting down")
    finally:
        camera.shutdown()


if __name__ == "__main__":  # pragma: no cover
    run_from_env()
