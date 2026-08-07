"""Camera capture layer — real USB webcam plus a mock fallback for dev.

The capture abstraction exposes a single ``CameraManager`` instance that the
publisher can ask for the latest JPEG frame. The manager owns a background
thread which reads frames at a soft fps cap, encodes them to JPEG, and stores
only the most recent one under a lock (last-writer-wins — no per-client
queueing, no backpressure).

If OpenCV can't open the configured V4L2 device (e.g. during laptop
development) the manager transparently falls back to a synthetic source that
renders a dark-gray frame with a live timestamp and a frame counter. This lets
the publisher and SecurityLuxHub be developed without any hardware.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import cv2  # type: ignore[import-untyped]
import numpy as np

from . import imaging
from .controls import CameraControls
from .imaging import ImageSettings
from .state import CameraState, StateValue

log = logging.getLogger(__name__)


@dataclass
class CameraConfig:
    device: str = "/dev/video0"
    width: int = 640
    height: int = 480
    fps: int = 15
    jpeg_quality: int = 70


class CameraManager:
    """Owns the capture thread and exposes the latest JPEG frame.

    Usage:
        manager = CameraManager(cfg, state)
        manager.start_if_on()  # attach to state changes; opens device if on
        jpeg_bytes = manager.get_latest_jpeg()  # None until first frame ready
    """

    def __init__(
        self,
        cfg: CameraConfig,
        state: CameraState,
        image_settings: Optional[ImageSettings] = None,
    ) -> None:
        self._cfg = cfg
        self._state = state

        self._lock = threading.Lock()
        self._latest_jpeg: Optional[bytes] = None
        self._frame_condition = threading.Condition(self._lock)

        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        # When True, the capture loop is in mock mode (no real device).
        self._using_mock = False
        self._mock_frame_counter = 0

        # Geometry adjustments. Held as an immutable object and swapped
        # wholesale, so the capture thread always reads a coherent set rather
        # than catching a half-updated one mid-frame. No lock needed for the
        # read — rebinding a reference is atomic under the GIL.
        self._image = image_settings or ImageSettings()

        # Hardware (V4L2) controls. Probed lazily on first use; a camera or host
        # without v4l2-ctl simply reports no controls.
        self._controls = CameraControls(cfg.device)

        # Hook state transitions so the hardware is released when feed goes off
        # and re-opened when it goes back on.
        state.on_change(self._on_state_change)

    # ------------------------------------------------------------------ public

    def start_if_on(self) -> None:
        """Open the capture thread if initial state is 'on'. Idempotent."""
        if self._state.get() == "on":
            self._start_capture()

    def shutdown(self) -> None:
        """Stop the capture thread and release hardware. Safe to call repeatedly."""
        self._stop_capture()

    def get_latest_jpeg(self, wait_seconds: float = 1.0) -> Optional[bytes]:
        """Return the most recent encoded JPEG, or None if none is ready yet.

        Blocks up to ``wait_seconds`` for the first frame to arrive after a
        cold start. Non-blocking once frames are flowing.
        """
        with self._frame_condition:
            if self._latest_jpeg is not None:
                return self._latest_jpeg
            self._frame_condition.wait(timeout=wait_seconds)
            return self._latest_jpeg

    def is_available(self) -> bool:
        """True if the capture thread is running (real or mock)."""
        return self._thread is not None and self._thread.is_alive()

    def using_mock(self) -> bool:
        return self._using_mock

    @property
    def resolution_str(self) -> str:
        """Effective resolution — 90/270 rotation swaps the axes."""
        width, height = imaging.output_size(
            self._cfg.width, self._cfg.height, self._image
        )
        return f"{width}x{height}"

    # -- image adjustments --------------------------------------------

    @property
    def image_settings(self) -> ImageSettings:
        return self._image

    def apply_image_settings(self, msg: dict) -> ImageSettings:
        """
        Merge a partial `image_config` payload into the current geometry.

        Takes effect on the very next captured frame — there is no need to
        reopen the device, which is what makes dragging a slider feel live.
        """
        updated = ImageSettings.from_message(msg, base=self._image)
        if updated != self._image:
            log.info("Image geometry updated: %s", updated.to_dict())
        self._image = updated
        return updated

    def list_hardware_controls(self) -> list[dict]:
        """Controls this specific camera supports, ready to render as a UI."""
        return [control.to_dict() for control in self._controls.list_controls()]

    def apply_hardware_controls(self, values: dict) -> dict:
        """Apply V4L2 controls. Returns `{applied, errors}` per control."""
        return self._controls.apply(values or {})

    def reset_hardware_controls(self) -> dict:
        """Restore every hardware control to the driver's own default."""
        return self._controls.reset()

    @property
    def hardware_controls_available(self) -> bool:
        return self._controls.available

    # ------------------------------------------------------------------ internals

    def _on_state_change(self, new_state: StateValue) -> None:
        if new_state == "on":
            self._start_capture()
        else:
            self._stop_capture()

    def _start_capture(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        with self._frame_condition:
            self._latest_jpeg = None
        self._thread = threading.Thread(
            target=self._capture_loop, name="camera-node-capture", daemon=True
        )
        self._thread.start()

    def _stop_capture(self) -> None:
        self._stop_event.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=2.0)
        self._thread = None

    def _capture_loop(self) -> None:
        """Thread target. Opens device (or mock), captures, encodes, stores."""
        capture = self._open_device()
        self._using_mock = capture is None
        if self._using_mock:
            log.warning("Using mock camera")

        frame_interval = 1.0 / max(self._cfg.fps, 1)

        try:
            while not self._stop_event.is_set():
                loop_start = time.monotonic()
                frame = self._grab_frame(capture)
                if frame is None:
                    # Real device returned nothing — short sleep and retry.
                    time.sleep(0.05)
                    continue

                # Adjustments happen here, before the encode, so the live feed,
                # the hub's recordings, and the detector all see the same
                # corrected image. `apply` short-circuits when nothing is set,
                # so an unadjusted camera pays nothing.
                frame = imaging.apply(frame, self._image)

                ok, buf = cv2.imencode(
                    ".jpg",
                    frame,
                    [int(cv2.IMWRITE_JPEG_QUALITY), int(self._cfg.jpeg_quality)],
                )
                if not ok:
                    log.warning("cv2.imencode failed; skipping frame")
                    continue
                jpeg = buf.tobytes()
                with self._frame_condition:
                    self._latest_jpeg = jpeg
                    self._frame_condition.notify_all()

                elapsed = time.monotonic() - loop_start
                remaining = frame_interval - elapsed
                if remaining > 0:
                    # Use stop_event.wait so shutdown is responsive.
                    if self._stop_event.wait(timeout=remaining):
                        break
        finally:
            if capture is not None:
                try:
                    capture.release()
                except Exception:  # pragma: no cover
                    log.exception("Error releasing VideoCapture")
            with self._frame_condition:
                self._latest_jpeg = None
                self._frame_condition.notify_all()

    def _open_device(self):
        """Try to open the configured V4L2 device. Return capture or None."""
        try:
            cap = cv2.VideoCapture(self._cfg.device, cv2.CAP_V4L2)
        except Exception:  # pragma: no cover - defensive
            log.exception("cv2.VideoCapture raised")
            return None
        if not cap or not cap.isOpened():
            if cap is not None:
                try:
                    cap.release()
                except Exception:  # pragma: no cover
                    pass
            return None
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._cfg.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._cfg.height)
        cap.set(cv2.CAP_PROP_FPS, self._cfg.fps)
        return cap

    def _grab_frame(self, capture) -> Optional[np.ndarray]:
        if capture is None:
            return self._build_mock_frame()
        ok, frame = capture.read()
        if not ok or frame is None:
            return None
        return frame

    def _build_mock_frame(self) -> np.ndarray:
        """Generate a dark-gray frame with a timestamp and frame counter."""
        self._mock_frame_counter += 1
        frame = np.full(
            (self._cfg.height, self._cfg.width, 3), 40, dtype=np.uint8
        )
        label = "MOCK CAMERA"
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        counter_text = f"frame {self._mock_frame_counter}"
        font = cv2.FONT_HERSHEY_SIMPLEX
        cv2.putText(frame, label, (20, 60), font, 1.2, (220, 220, 220), 2, cv2.LINE_AA)
        cv2.putText(frame, timestamp, (20, 110), font, 0.7, (180, 180, 180), 1, cv2.LINE_AA)
        cv2.putText(frame, counter_text, (20, 140), font, 0.7, (180, 180, 180), 1, cv2.LINE_AA)
        return frame
