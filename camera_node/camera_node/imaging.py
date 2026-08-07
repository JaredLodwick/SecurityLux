"""Geometric image adjustments applied on the camera, before JPEG encode.

Why here and not somewhere else
-------------------------------
These transforms run on the camera Pi, upstream of the JPEG encode, so the
live feed, the recorded clips, and the hub's person detector all see the same
corrected image.

The alternatives are both wrong for a security system:

  * **CSS transforms in the browser** would rotate what you see and nothing
    else. The recordings would still be sideways, and — worse — YOLO would be
    looking at a sideways person, which degrades detection badly. A camera
    mounted rotated is exactly the case where you most need detection to work.

  * **Transforming on the hub** means decoding, transforming, and re-encoding
    every frame from every camera. That is a large, permanent CPU cost on the
    hub for something the camera can do essentially for free as part of an
    encode it is already performing.

Cost on a Pi Zero 2 W
---------------------
`is_identity` short-circuits the whole pipeline, so a camera with default
settings pays nothing at all — no copy, no branch beyond one boolean.

When adjustments are active: 180° rotation and flips are cheap array views;
90/270 is a transpose plus a flip; zoom is a slice plus one `cv2.resize`.
At 640x480 the whole chain is low single-digit milliseconds, against a 66 ms
budget at 15 fps.

Note that 90° and 270° rotation swap width and height, so the camera's
effective resolution changes — `output_size` is the source of truth for what
the hub is actually receiving.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Optional

import cv2  # type: ignore[import-untyped]
import numpy as np

VALID_ROTATIONS = (0, 90, 180, 270)

MIN_ZOOM = 1.0
MAX_ZOOM = 4.0

_ROTATION_CODES = {
    90: cv2.ROTATE_90_CLOCKWISE,
    180: cv2.ROTATE_180,
    270: cv2.ROTATE_90_COUNTERCLOCKWISE,
}


@dataclass(frozen=True)
class ImageSettings:
    """Geometry adjustments. Immutable so the capture thread can swap it atomically."""

    rotation: int = 0                 # 0, 90, 180, 270 — clockwise
    flip_horizontal: bool = False     # mirror left/right
    flip_vertical: bool = False       # mirror top/bottom
    zoom: float = 1.0                 # 1.0 = full frame, 4.0 = 4x digital zoom
    pan_x: float = 0.0                # -1 fully left, +1 fully right (only when zoomed)
    pan_y: float = 0.0                # -1 fully up, +1 fully down

    @property
    def is_identity(self) -> bool:
        """True when nothing needs doing, so the capture loop can skip the work."""
        return (
            self.rotation == 0
            and not self.flip_horizontal
            and not self.flip_vertical
            and self.zoom <= MIN_ZOOM
        )

    @property
    def swaps_axes(self) -> bool:
        """90/270 rotation exchanges width and height."""
        return self.rotation in (90, 270)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rotation": self.rotation,
            "flipHorizontal": self.flip_horizontal,
            "flipVertical": self.flip_vertical,
            "zoom": round(self.zoom, 3),
            "panX": round(self.pan_x, 3),
            "panY": round(self.pan_y, 3),
        }

    @classmethod
    def from_message(cls, msg: dict[str, Any], base: Optional["ImageSettings"] = None) -> "ImageSettings":
        """
        Build settings from a hub `image_config` message.

        Keys that are absent are inherited from ``base`` rather than reset, so a
        partial update (one slider moved) doesn't clobber everything else.
        Every value is clamped rather than rejected — a nonsensical value from
        the network should degrade to something sane, not stop the camera.
        """
        current = base or cls()
        if not isinstance(msg, dict):
            return current

        return cls(
            rotation=_clamp_rotation(msg.get("rotation"), current.rotation),
            flip_horizontal=_clamp_bool(msg.get("flipHorizontal"), current.flip_horizontal),
            flip_vertical=_clamp_bool(msg.get("flipVertical"), current.flip_vertical),
            zoom=_clamp_float(msg.get("zoom"), current.zoom, MIN_ZOOM, MAX_ZOOM),
            pan_x=_clamp_float(msg.get("panX"), current.pan_x, -1.0, 1.0),
            pan_y=_clamp_float(msg.get("panY"), current.pan_y, -1.0, 1.0),
        )

    def with_rotation(self, rotation: int) -> "ImageSettings":
        return replace(self, rotation=_clamp_rotation(rotation, self.rotation))


def output_size(width: int, height: int, settings: ImageSettings) -> tuple[int, int]:
    """Frame dimensions after transforms. Zoom preserves size; rotation may swap it."""
    if settings.swaps_axes:
        return height, width
    return width, height


def apply(frame: np.ndarray, settings: ImageSettings) -> np.ndarray:
    """
    Apply zoom, then flips, then rotation.

    Order matters and is chosen to match what a person expects while adjusting:
    zoom picks *what* you see, flips and rotation decide how it's oriented. Doing
    rotation first would make the pan axes swap under the user mid-drag, which
    feels broken.
    """
    if frame is None or settings.is_identity:
        return frame

    result = frame
    if settings.zoom > MIN_ZOOM:
        result = _apply_zoom(result, settings)

    if settings.flip_horizontal and settings.flip_vertical:
        result = cv2.flip(result, -1)       # both axes in one pass
    elif settings.flip_horizontal:
        result = cv2.flip(result, 1)
    elif settings.flip_vertical:
        result = cv2.flip(result, 0)

    code = _ROTATION_CODES.get(settings.rotation)
    if code is not None:
        result = cv2.rotate(result, code)

    return result


def _apply_zoom(frame: np.ndarray, settings: ImageSettings) -> np.ndarray:
    """
    Crop a sub-region and scale it back up — digital zoom.

    Detail is genuinely lost (there are no extra pixels to recover), but for
    framing a doorway that fills a third of the sensor it is exactly the right
    tool, and it means the detector sees a larger person too.
    """
    height, width = frame.shape[:2]
    zoom = max(MIN_ZOOM, min(settings.zoom, MAX_ZOOM))

    crop_w = max(1, int(round(width / zoom)))
    crop_h = max(1, int(round(height / zoom)))

    # Pan moves the crop across whatever travel the zoom level leaves over.
    # At zoom 1 there is no travel, so pan is a no-op rather than an error.
    travel_x = (width - crop_w) / 2.0
    travel_y = (height - crop_h) / 2.0
    center_x = width / 2.0 + settings.pan_x * travel_x
    center_y = height / 2.0 + settings.pan_y * travel_y

    left = int(round(center_x - crop_w / 2.0))
    top = int(round(center_y - crop_h / 2.0))
    left = max(0, min(left, width - crop_w))
    top = max(0, min(top, height - crop_h))

    cropped = frame[top:top + crop_h, left:left + crop_w]

    # INTER_LINEAR: INTER_CUBIC looks marginally better and costs noticeably
    # more per frame on a Zero 2 W, which is the wrong trade at 15 fps.
    return cv2.resize(cropped, (width, height), interpolation=cv2.INTER_LINEAR)


def _clamp_rotation(value: Any, fallback: int) -> int:
    try:
        rotation = int(value)
    except (TypeError, ValueError):
        return fallback
    rotation %= 360
    return rotation if rotation in VALID_ROTATIONS else fallback


def _clamp_bool(value: Any, fallback: bool) -> bool:
    if value is None:
        return fallback
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return fallback


def _clamp_float(value: Any, fallback: float, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number or number in (float("inf"), float("-inf")):  # NaN / inf
        return fallback
    return max(low, min(number, high))
