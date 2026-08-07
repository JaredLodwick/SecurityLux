"""V4L2 hardware image controls — brightness, contrast, exposure, and friends.

Why v4l2-ctl rather than OpenCV
-------------------------------
OpenCV exposes `CAP_PROP_BRIGHTNESS` and similar, but its behaviour across
backends is inconsistent: some normalise to 0-1, some pass raw driver units,
and none of them tell you the control's actual range or whether the camera
supports it at all. Guessing that a slider spans 0-255 when the driver wants
-64..64 produces a control that appears to do nothing over half its travel.

`v4l2-ctl --list-ctrls` reports exactly which controls the device has, their
real min/max/step/default, the current value, and whether a control is
currently inactive. That is what makes it possible to render only the controls
a given camera genuinely supports — which is the whole point, since UVC webcams
vary enormously in what they expose.

v4l-utils is already an apt dependency of camera_node.

Cost
----
These are *hardware* controls: the sensor or the driver applies them, so unlike
the geometry transforms in imaging.py they cost zero CPU per frame no matter
how far you push them. Prefer them over software equivalents wherever both
exist.

Everything here degrades to a no-op when v4l2-ctl is missing, the device isn't
a real V4L2 node, or we're on a dev laptop using the mock camera.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
from dataclasses import dataclass, asdict
from typing import Any, Optional

log = logging.getLogger(__name__)

COMMAND_TIMEOUT_SECONDS = 4.0

# Controls worth surfacing, in the order the UI should show them.
#
# Kernel and driver versions disagree on some names (the UVC driver renamed
# several controls around Linux 6.x), so each entry lists the aliases we accept
# and the stable id the hub and UI use. Anything not listed here is ignored —
# a webcam exposing 40 obscure controls should not produce a wall of sliders.
CONTROL_SPECS: tuple[dict[str, Any], ...] = (
    {"id": "brightness", "label": "Brightness",
     "aliases": ("brightness",)},
    {"id": "contrast", "label": "Contrast",
     "aliases": ("contrast",)},
    {"id": "saturation", "label": "Saturation",
     "aliases": ("saturation",)},
    {"id": "sharpness", "label": "Sharpness",
     "aliases": ("sharpness",)},
    {"id": "gamma", "label": "Gamma",
     "aliases": ("gamma",)},
    {"id": "gain", "label": "Gain",
     "aliases": ("gain",)},
    {"id": "backlight_compensation", "label": "Backlight compensation",
     "aliases": ("backlight_compensation",),
     "help": "Lifts a subject that is silhouetted against a bright doorway."},
    {"id": "auto_exposure", "label": "Auto exposure",
     "aliases": ("auto_exposure", "exposure_auto"),
     "help": "Turn off to set exposure manually — useful when a porch light "
             "or headlights keep making the camera hunt."},
    {"id": "exposure_time_absolute", "label": "Exposure time",
     "aliases": ("exposure_time_absolute", "exposure_absolute"),
     "help": "Longer exposure means a brighter night image but more motion blur."},
    {"id": "white_balance_automatic", "label": "Auto white balance",
     "aliases": ("white_balance_automatic", "white_balance_temperature_auto")},
    {"id": "white_balance_temperature", "label": "White balance",
     "aliases": ("white_balance_temperature",)},
    {"id": "power_line_frequency", "label": "Anti-flicker",
     "aliases": ("power_line_frequency",),
     "help": "Set to your mains frequency (50 Hz in the UK/EU, 60 Hz in the US) "
             "to stop indoor lighting banding the image."},
)

# device-name -> stable id, built once from the aliases above.
_ALIAS_TO_ID: dict[str, str] = {
    alias: spec["id"]
    for spec in CONTROL_SPECS
    for alias in spec["aliases"]
}
_SPEC_BY_ID: dict[str, dict[str, Any]] = {spec["id"]: spec for spec in CONTROL_SPECS}
_ORDER = {spec["id"]: index for index, spec in enumerate(CONTROL_SPECS)}

# e.g.  brightness 0x00980900 (int)    : min=-64 max=64 step=1 default=0 value=0
#       auto_exposure 0x009a0901 (menu)   : min=0 max=3 default=3 value=1
#       white_balance_automatic 0x0098090c (bool)   : default=1 value=1 flags=inactive
_CONTROL_LINE = re.compile(
    r"^\s*(?P<name>\w+)\s+0x[0-9a-fA-F]+\s+\((?P<kind>\w+)\)\s*:\s*(?P<rest>.*)$"
)
_KEY_VALUE = re.compile(r"(\w+)=(-?\d+)")


@dataclass
class Control:
    """One adjustable hardware control, as the UI needs to render it."""

    id: str                       # stable id used by the hub and UI
    name: str                     # the driver's own name, used when setting
    label: str
    kind: str                     # "int" | "bool" | "menu"
    min: Optional[int]
    max: Optional[int]
    step: Optional[int]
    default: Optional[int]
    value: Optional[int]
    inactive: bool = False        # e.g. manual exposure while auto is on
    help: Optional[str] = None
    options: Optional[list[dict[str, Any]]] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# Menu controls report integers; these are the labels users actually understand.
MENU_LABELS: dict[str, dict[int, str]] = {
    "power_line_frequency": {0: "Disabled", 1: "50 Hz", 2: "60 Hz", 3: "Auto"},
    "auto_exposure": {0: "Auto", 1: "Manual", 2: "Shutter priority", 3: "Aperture priority"},
}


class CameraControls:
    """Probes and sets V4L2 controls for one device."""

    def __init__(self, device: str) -> None:
        self.device = device
        self._available: Optional[bool] = None
        self._warned = False

    # -- availability -------------------------------------------------

    @property
    def available(self) -> bool:
        """Whether v4l2-ctl exists and the device answers to it. Cached."""
        if self._available is None:
            self._available = self._probe_availability()
        return self._available

    def _probe_availability(self) -> bool:
        if shutil.which("v4l2-ctl") is None:
            self._warn(
                "v4l2-ctl not found, so hardware image controls are unavailable. "
                "Install it with: sudo apt install v4l-utils"
            )
            return False
        result = self._run(["--list-ctrls"])
        if result is None:
            self._warn(f"{self.device} did not respond to v4l2-ctl; no hardware controls.")
            return False
        return True

    def _warn(self, message: str) -> None:
        # Once only — a camera without controls should not fill the journal.
        if not self._warned:
            log.warning("%s", message)
            self._warned = True

    # -- probing ------------------------------------------------------

    def list_controls(self) -> list[Control]:
        """
        Every supported control, in display order.

        Returns an empty list rather than raising when the device has no
        controls or v4l2-ctl is missing — the UI then simply shows nothing,
        which is the correct outcome for a camera that can't be adjusted.
        """
        if not self.available:
            return []

        output = self._run(["--list-ctrls"])
        if output is None:
            return []

        controls: dict[str, Control] = {}
        for line in output.splitlines():
            parsed = self._parse_line(line)
            if parsed is None:
                continue
            # First alias wins: a driver exposing both the old and new name for
            # the same control should not produce two sliders.
            controls.setdefault(parsed.id, parsed)

        return sorted(controls.values(), key=lambda c: _ORDER.get(c.id, 999))

    def _parse_line(self, line: str) -> Optional[Control]:
        match = _CONTROL_LINE.match(line)
        if not match:
            return None

        name = match.group("name")
        control_id = _ALIAS_TO_ID.get(name)
        if control_id is None:
            return None       # not one of the controls we surface

        rest = match.group("rest")
        fields = {key: int(val) for key, val in _KEY_VALUE.findall(rest)}
        spec = _SPEC_BY_ID[control_id]
        kind = match.group("kind")

        options = None
        if kind == "menu":
            labels = MENU_LABELS.get(control_id, {})
            low = fields.get("min", 0)
            high = fields.get("max", 0)
            options = [
                {"value": value, "label": labels.get(value, str(value))}
                for value in range(low, high + 1)
            ]

        return Control(
            id=control_id,
            name=name,
            label=spec["label"],
            kind=kind,
            min=fields.get("min"),
            max=fields.get("max"),
            step=fields.get("step"),
            default=fields.get("default"),
            value=fields.get("value"),
            # The driver marks a control inactive when something else disables
            # it — manual exposure while auto-exposure is on, for instance. The
            # UI greys these out instead of offering a slider that does nothing.
            inactive="flags=inactive" in rest,
            help=spec.get("help"),
            options=options,
        )

    # -- setting ------------------------------------------------------

    def set(self, control_id: str, value: Any) -> dict[str, Any]:
        """
        Set one control by its stable id.

        Returns `{ok, error}` rather than raising: a control that a particular
        camera rejects should surface as a message in the UI, not take down the
        publisher.
        """
        if not self.available:
            return {"ok": False, "error": "hardware controls are unavailable on this camera"}

        try:
            numeric = int(round(float(value)))
        except (TypeError, ValueError):
            return {"ok": False, "error": f"{control_id} must be a number"}

        current = {control.id: control for control in self.list_controls()}
        control = current.get(control_id)
        if control is None:
            return {"ok": False, "error": f"this camera has no {control_id} control"}

        # Clamp to the driver's range. v4l2-ctl clamps silently, but doing it
        # here means the value we report back matches what was actually applied.
        if control.min is not None:
            numeric = max(control.min, numeric)
        if control.max is not None:
            numeric = min(control.max, numeric)

        result = self._run(["--set-ctrl", f"{control.name}={numeric}"])
        if result is None:
            return {"ok": False, "error": f"the camera rejected {control_id}={numeric}"}

        log.info("Set %s=%s on %s", control.name, numeric, self.device)
        return {"ok": True, "id": control_id, "value": numeric}

    def apply(self, values: dict[str, Any]) -> dict[str, Any]:
        """
        Apply several controls, returning per-control results.

        Auto flags are applied first: setting manual exposure while auto
        exposure is still on is silently ignored by the driver, so ordering is
        the difference between the slider working and appearing to do nothing.
        """
        if not values:
            return {"applied": {}, "errors": {}}

        auto_first = sorted(
            values.items(),
            key=lambda item: 0 if item[0] in ("auto_exposure", "white_balance_automatic") else 1
        )

        applied: dict[str, int] = {}
        errors: dict[str, str] = {}
        for control_id, value in auto_first:
            outcome = self.set(control_id, value)
            if outcome.get("ok"):
                applied[control_id] = outcome["value"]
            else:
                errors[control_id] = outcome.get("error", "unknown error")
        return {"applied": applied, "errors": errors}

    def reset(self) -> dict[str, Any]:
        """Restore every supported control to the driver's own default."""
        controls = self.list_controls()
        defaults = {
            control.id: control.default
            for control in controls
            if control.default is not None
        }
        return self.apply(defaults)

    # -- process plumbing ---------------------------------------------

    def _run(self, args: list[str]) -> Optional[str]:
        """Run v4l2-ctl against this device. Returns stdout, or None on failure."""
        command = ["v4l2-ctl", "-d", self.device, *args]
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                timeout=COMMAND_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            log.debug("v4l2-ctl %s failed: %s", " ".join(args), exc)
            return None

        if completed.returncode != 0:
            log.debug(
                "v4l2-ctl %s exited %d: %s",
                " ".join(args), completed.returncode,
                completed.stderr.decode("utf-8", "replace").strip(),
            )
            return None
        return completed.stdout.decode("utf-8", "replace")


def parse_controls(output: str) -> list[Control]:
    """Parse `v4l2-ctl --list-ctrls` output. Exposed for tests."""
    probe = CameraControls("/dev/null")
    probe._available = True   # skip the availability check; we already have output
    controls: dict[str, Control] = {}
    for line in output.splitlines():
        parsed = probe._parse_line(line)
        if parsed is not None:
            controls.setdefault(parsed.id, parsed)
    return sorted(controls.values(), key=lambda c: _ORDER.get(c.id, 999))
