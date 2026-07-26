"""WebSocket publisher — pushes frames and status to SecurityLuxHub.

The Pi camera is a low-power node; the always-on hub owns camera state. This
module connects out to ``ws://<hub>/cam/<cam_id>``, sends:

  * binary JPEG frames while the camera is on (last-writer-wins, fps-capped)
  * text JSON status messages every few seconds (battery, fps, resolution)

and listens for control messages from the hub:

  * ``{"type": "set_state", "state": "on" | "off"}`` → drives the local
    ``CameraState`` so ``CameraManager`` opens or releases the device.
  * ``{"type": "led_config", ...}``    → configure the door light strip.
  * ``{"type": "led", ...}``           → play a door-light stage.
  * ``{"type": "restart_service"}``    → exit cleanly; systemd restarts us.
  * ``{"type": "reboot"}``             → reboot the Pi.

All hardware ownership stays in ``camera.py`` / ``state.py`` / ``pisugar.py`` /
``led.py`` — this file is the network adapter and the command router.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import subprocess
import time
from typing import Any, Optional
from urllib.parse import quote

import websockets
from websockets.exceptions import ConnectionClosed

from .camera import CameraConfig, CameraManager
from .led import LedController
from .pisugar import PiSugarClient
from .state import CameraState, StateValue

log = logging.getLogger(__name__)

STATUS_INTERVAL_SECONDS = 5.0
RECONNECT_BACKOFF_INITIAL = 1.0
RECONNECT_BACKOFF_MAX = 30.0

# Give the WebSocket a moment to flush an acknowledgement before we exit or
# reboot, so the hub sees the command land rather than a bare disconnect.
COMMAND_ACK_GRACE_SECONDS = 0.5

PROCESS_STARTED_AT = time.monotonic()

# Exit code used for a hub-requested restart. systemd brings us straight back
# (the unit uses Restart=always); the distinct code makes the intent obvious in
# `journalctl` rather than looking like a crash.
RESTART_EXIT_CODE = 0

REBOOT_COMMANDS = (
    ["sudo", "-n", "/usr/bin/systemctl", "reboot"],
    ["sudo", "-n", "/sbin/reboot"],
)


class RestartRequested(Exception):
    """
    Unwinds the session when the hub asks the service to restart.

    A plain ``Exception`` rather than ``SystemExit`` on purpose: raising a
    ``BaseException`` inside a Task gets special-cased by asyncio and its exact
    propagation is easy to get subtly wrong. This unwinds through the normal
    error path, where it's handled explicitly and can't be swallowed by the
    catch-all that guards against unexpected session errors.
    """


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
        led: Optional[LedController] = None,
    ) -> None:
        self.hub_url = hub_url.rstrip("/")
        self.cam_id = cam_id
        self.camera = camera
        self.state = state
        self.pisugar = pisugar
        self.cam_cfg = cam_cfg
        self.led = led or LedController(enabled=False)
        self._shutdown_reason: Optional[str] = None

    @property
    def endpoint(self) -> str:
        return f"{self.hub_url}/cam/{quote(self.cam_id, safe='')}"

    @property
    def shutdown_reason(self) -> Optional[str]:
        """Why ``run()`` returned: ``"restart"``, or None for a normal stop."""
        return self._shutdown_reason

    async def run(self) -> None:
        """Connect-loop with exponential backoff. Returns on cancellation."""
        self.led.start()
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
            except RestartRequested:
                log.info("Exiting so systemd can restart the service")
                self._shutdown_reason = "restart"
                return
            except (OSError, ConnectionClosed, asyncio.TimeoutError) as exc:
                log.warning("Hub connection failed/closed: %s", exc)
            except Exception:
                log.exception("Unexpected error in publisher session")

            if self._shutdown_reason:
                return

            self.state.set("off")
            # Nothing is refreshing the door light's TTL while we're
            # disconnected, so it decays to idle on its own — but be explicit
            # rather than relying on the timeout to tidy up.
            self.led.submit({"pattern": "off", "stage": 0, "ttlMs": 0})
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)

    async def _session(self, ws: "websockets.WebSocketClientProtocol") -> None:
        await ws.send(json.dumps({
            "type": "hello",
            "cam_id": self.cam_id,
            "capabilities": {
                "fps": int(self.cam_cfg.fps),
                "resolution": f"{self.cam_cfg.width}x{self.cam_cfg.height}",
                "jpeg_quality": int(self.cam_cfg.jpeg_quality),
                "led": self.led.enabled,
                "commands": ["set_state", "led", "led_config", "restart_service", "reboot"],
            },
        }))

        recv_task = asyncio.create_task(self._receive_loop(ws))
        frame_task = asyncio.create_task(self._frame_loop(ws))
        status_task = asyncio.create_task(self._status_loop(ws))
        tasks = (recv_task, frame_task, status_task)
        try:
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
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
            for task in tasks:
                if not task.done():
                    task.cancel()

    async def _receive_loop(self, ws: "websockets.WebSocketClientProtocol") -> None:
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
            await self._handle_command(msg, ws)

    async def _handle_command(
        self, msg: dict[str, Any], ws: "websockets.WebSocketClientProtocol"
    ) -> None:
        mtype = msg.get("type")

        if mtype == "set_state":
            desired = msg.get("state")
            if desired in ("on", "off"):
                log.info("Hub requested state=%s", desired)
                self.state.set(desired)  # type: ignore[arg-type]

        elif mtype == "led_config":
            self.led.apply_config(msg)

        elif mtype == "led":
            self.led.submit(msg)

        elif mtype == "restart_service":
            log.info("Hub requested a service restart")
            await self._acknowledge(ws, "restart_service")
            raise RestartRequested()

        elif mtype == "reboot":
            log.warning("Hub requested a reboot")
            await self._acknowledge(ws, "reboot")
            self._reboot()

        elif mtype == "hello_ack":
            pass

        else:
            log.debug("Ignoring unknown command type: %s", mtype)

    async def _acknowledge(
        self, ws: "websockets.WebSocketClientProtocol", action: str
    ) -> None:
        """Tell the hub we accepted a command before we disappear."""
        with contextlib.suppress(Exception):
            await ws.send(json.dumps({
                "type": "ack", "cam_id": self.cam_id, "action": action,
            }))
        await asyncio.sleep(COMMAND_ACK_GRACE_SECONDS)

    def _reboot(self) -> None:
        """
        Reboot the Pi.

        Requires the scoped sudoers rule the installer writes. If it isn't
        there, say so precisely — a silent failure here is maddening to debug,
        because from the dashboard it just looks like the camera ignored you.
        """
        self.led.teardown()
        for command in REBOOT_COMMANDS:
            try:
                result = subprocess.run(command, capture_output=True, timeout=10, check=False)
            except (OSError, subprocess.TimeoutExpired) as exc:
                log.warning("Reboot via %s failed: %s", " ".join(command), exc)
                continue
            if result.returncode == 0:
                log.warning("Reboot command accepted: %s", " ".join(command))
                return
            log.warning(
                "Reboot via %s exited %d: %s",
                " ".join(command), result.returncode,
                result.stderr.decode("utf-8", "replace").strip(),
            )
        log.error(
            "Could not reboot. The camera_node service needs passwordless sudo for "
            "systemctl reboot — re-run camera_node/install.sh, which installs "
            "/etc/sudoers.d/securitylux-camera-node for exactly that command."
        )

    async def _frame_loop(self, ws: "websockets.WebSocketClientProtocol") -> None:
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

    async def _status_loop(self, ws: "websockets.WebSocketClientProtocol") -> None:
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
            "led_available": self.led.available,
            # Uptime of this process, not the host. It's what tells you whether
            # a remote restart actually took effect.
            "uptime_s": round(time.monotonic() - PROCESS_STARTED_AT, 1),
        }


def run_from_env() -> None:
    """Entry point used by ``python -m camera_node``."""
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

    led_cfg = config.get("led", {})
    led = LedController(
        count=int(led_cfg.get("count", 8)),
        enabled=bool(led_cfg.get("enabled", False)),
        max_brightness=float(led_cfg.get("max_brightness", 0.4)),
    )
    if led.enabled:
        led.setup()

    hub_url = str(config["hub"]["url"])
    publisher = Publisher(hub_url, cam_id, camera, state, pisugar, cam_cfg, led)

    try:
        asyncio.run(publisher.run())
    except KeyboardInterrupt:
        log.info("Shutting down")
    finally:
        camera.shutdown()
        led.teardown()

    if publisher.shutdown_reason == "restart":
        # Clean exit; the unit uses Restart=always so systemd brings us
        # straight back with the device released and the WS reconnected.
        raise SystemExit(RESTART_EXIT_CODE)


if __name__ == "__main__":  # pragma: no cover
    run_from_env()
