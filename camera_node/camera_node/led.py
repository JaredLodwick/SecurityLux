"""NeoPixel door light.

Drives a WS281x strip attached to the camera Pi. The hub decides *what to
convey* (a stage, 0-4); this module decides how it looks frame by frame.

Why the split: the strip is on the camera Pi, so animating from the hub would
mean streaming pixel data over WiFi and every dropped packet would show up as a
visible stutter on someone's porch. The hub sends a stage; the animation runs
locally at a steady 50 fps regardless of the network.

SPI, not PWM
------------
The strip is driven over SPI (GPIO10 / MOSI, physical pin 19) rather than the
more commonly documented PWM pin. Two concrete reasons:

  * ``rpi_ws281x`` on a PWM pin needs root. The camera node runs as an
    unprivileged systemd service, and giving a network-facing process root to
    blink an LED is a bad trade.
  * GPIO18 (the usual PWM choice) conflicts with the Pi's onboard audio.

The cost is that SPI clock accuracy matters — see the ``core_freq_min`` note in
the camera_node README.

Power
-----
Eight LEDs at full white draw roughly 480 mA. That is more than the Pi Zero's
5V rail wants to supply while a PiSugar is also charging, which is why the hub
caps brightness at 40% by default. Anything brighter should be fed from a
separate 5V supply with a common ground.

Degradation
-----------
Every hardware dependency is imported behind a guard. On a camera with no strip,
no SPI enabled, or no Adafruit libraries installed, this becomes a no-op that
logs once — the camera keeps streaming exactly as before. A door light is a
nice-to-have; a camera is not.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any, Optional, Sequence

log = logging.getLogger(__name__)

FRAME_INTERVAL = 1.0 / 50           # 50 fps is smooth and costs ~1% CPU
DEFAULT_LED_COUNT = 8
IDLE_FADE_SECONDS = 0.8             # how long the fade to idle takes on TTL expiry

Color = tuple[int, int, int]


@dataclass
class LedCommand:
    """A stage as sent by the hub."""

    pattern: str = "off"
    color: Color = (0, 0, 0)
    brightness: float = 0.0
    period_ms: int = 0
    stage: int = 0
    ttl_ms: int = 0
    received_at: float = field(default_factory=time.monotonic)

    @property
    def expired(self) -> bool:
        """
        True once the hub has stopped refreshing this command.

        This is a dead-man's switch, and it is the whole reason ``ttl_ms``
        exists. If the hub crashes mid-event or WiFi drops while someone is
        standing at the door, the failure mode has to be "the light goes out",
        not "the light stays on all night".
        """
        if self.ttl_ms <= 0:
            return False
        return (time.monotonic() - self.received_at) * 1000.0 > self.ttl_ms

    @classmethod
    def from_message(cls, msg: dict[str, Any]) -> "LedCommand":
        raw_color = msg.get("color") or [0, 0, 0]
        try:
            color = (
                int(raw_color[0]) & 0xFF,
                int(raw_color[1]) & 0xFF,
                int(raw_color[2]) & 0xFF,
            )
        except (TypeError, ValueError, IndexError):
            color = (0, 0, 0)
        return cls(
            pattern=str(msg.get("pattern", "off")),
            color=color,
            brightness=_clamp01(msg.get("brightness", 0.0)),
            period_ms=_safe_int(msg.get("periodMs"), 0),
            stage=_safe_int(msg.get("stage"), 0),
            ttl_ms=_safe_int(msg.get("ttlMs"), 0),
        )


class LedController:
    """Owns the strip and the animation loop."""

    def __init__(
        self,
        count: int = DEFAULT_LED_COUNT,
        enabled: bool = False,
        max_brightness: float = 0.4,
    ) -> None:
        self.count = max(1, int(count))
        self.enabled = bool(enabled)
        self.max_brightness = _clamp01(max_brightness)

        self._pixels: Optional[Any] = None
        self._spi: Optional[Any] = None
        self._available = False
        self._init_error: Optional[str] = None
        self._command = LedCommand()
        self._task: Optional[asyncio.Task] = None
        self._fade_from: Optional[Sequence[Color]] = None
        self._fade_started: float = 0.0

    # -- lifecycle ---------------------------------------------------

    @property
    def available(self) -> bool:
        """Whether real hardware is behind this controller."""
        return self._available

    def setup(self) -> bool:
        """
        Initialise the strip. Safe to call repeatedly.

        Never raises: a missing library, a disabled SPI bus, or a wiring fault
        must not stop the camera from streaming.
        """
        if not self.enabled:
            return False
        if self._available:
            return True

        try:
            import board  # type: ignore
            import neopixel_spi  # type: ignore
        except ImportError as exc:
            self._fail(
                f"NeoPixel libraries not installed ({exc}). "
                "Install with: pip install adafruit-circuitpython-neopixel-spi"
            )
            return False

        try:
            self._spi = board.SPI()
            self._pixels = neopixel_spi.NeoPixel_SPI(
                self._spi,
                self.count,
                pixel_order=neopixel_spi.GRB,
                auto_write=False,
                brightness=1.0,   # scaling happens in software so the hub's cap is exact
            )
            self._pixels.fill((0, 0, 0))
            self._pixels.show()
        except Exception as exc:  # noqa: BLE001 - hardware init fails in many ways
            self._fail(
                f"could not initialise the LED strip ({exc}). "
                "Check that SPI is enabled (sudo raspi-config > Interface Options > SPI) "
                "and that the strip's data line is on GPIO10 / physical pin 19."
            )
            return False

        self._available = True
        self._init_error = None
        log.info("NeoPixel strip ready: %d LEDs on SPI (max brightness %.0f%%)",
                 self.count, self.max_brightness * 100)
        return True

    def _fail(self, message: str) -> None:
        # Log once. A camera without a strip should not fill the journal.
        if self._init_error != message:
            log.warning("Door light disabled: %s", message)
        self._init_error = message
        self._available = False

    def apply_config(self, msg: dict[str, Any]) -> None:
        """Handle a ``led_config`` message from the hub."""
        was_enabled = self.enabled
        self.enabled = bool(msg.get("enabled", False))
        new_count = _safe_int(msg.get("count"), self.count)
        self.max_brightness = _clamp01(msg.get("maxBrightness", self.max_brightness))

        if new_count != self.count:
            self.count = max(1, new_count)
            self.teardown()

        if self.enabled and not was_enabled:
            self.setup()
        elif not self.enabled and was_enabled:
            self.teardown()

    def submit(self, msg: dict[str, Any]) -> None:
        """Handle a ``led`` message from the hub."""
        if not self.enabled:
            return
        if not self._available and not self.setup():
            return

        command = LedCommand.from_message(msg)
        # Capture the current frame so a change of stage cross-fades rather than
        # snapping, which reads as a glitch on a strip this small.
        if command.stage != self._command.stage:
            self._fade_from = self._render(self._command, time.monotonic())
            self._fade_started = time.monotonic()
        self._command = command

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None
        self.teardown()

    def teardown(self) -> None:
        """Blank the strip and release the SPI bus."""
        if self._pixels is not None:
            try:
                self._pixels.fill((0, 0, 0))
                self._pixels.show()
            except Exception:  # noqa: BLE001
                pass
        self._pixels = None
        if self._spi is not None:
            try:
                self._spi.deinit()
            except Exception:  # noqa: BLE001
                pass
        self._spi = None
        self._available = False

    # -- animation ---------------------------------------------------

    async def _run(self) -> None:
        """Render frames until cancelled."""
        while True:
            try:
                if self._available:
                    self._draw()
            except Exception as exc:  # noqa: BLE001
                # A transient SPI error must not kill the loop; drop the strip
                # and let the next command re-initialise it.
                log.warning("LED render failed: %s", exc)
                self._available = False
            await asyncio.sleep(FRAME_INTERVAL)

    def _draw(self) -> None:
        now = time.monotonic()
        command = self._command

        # TTL expiry: the hub has gone quiet, so decay to idle.
        if command.expired:
            if command.stage != 0:
                log.info("Door light command expired (hub went quiet); fading to idle")
                self._fade_from = self._render(command, now)
                self._fade_started = now
                self._command = LedCommand()
                command = self._command
            else:
                command = self._command

        frame = self._render(command, now)

        # Cross-fade out of the previous stage.
        if self._fade_from is not None:
            elapsed = now - self._fade_started
            if elapsed >= IDLE_FADE_SECONDS:
                self._fade_from = None
            else:
                ratio = elapsed / IDLE_FADE_SECONDS
                frame = [
                    _blend(old, new, ratio)
                    for old, new in zip(self._fade_from, frame)
                ]

        for i, color in enumerate(frame):
            self._pixels[i] = color
        self._pixels.show()

    def _render(self, command: LedCommand, now: float) -> list[Color]:
        """Compute one frame for a command. Pure — no hardware access."""
        brightness = min(command.brightness, self.max_brightness)
        if command.pattern == "off" or brightness <= 0:
            return [(0, 0, 0)] * self.count

        base = command.color
        period = max(0.15, command.period_ms / 1000.0) if command.period_ms else 1.0

        if command.pattern == "solid":
            return [_scale(base, brightness)] * self.count

        if command.pattern == "breathe":
            # Sine eased to spend longer near the bottom, which reads as calm
            # breathing rather than a throb.
            phase = (math.sin(2 * math.pi * (now % period) / period) + 1) / 2
            level = brightness * (0.25 + 0.75 * phase ** 1.6)
            return [_scale(base, level)] * self.count

        if command.pattern == "pulse":
            phase = (math.sin(2 * math.pi * (now % period) / period) + 1) / 2
            level = brightness * (0.45 + 0.55 * phase)
            return [_scale(base, level)] * self.count

        if command.pattern == "sweep":
            # A single lit comet running the length of the strip.
            pos = ((now % period) / period) * (self.count + 3) - 1.5
            frame = []
            for i in range(self.count):
                distance = abs(i - pos)
                level = brightness * max(0.0, 1.0 - distance / 1.8)
                frame.append(_scale(base, level))
            return frame

        if command.pattern == "chase":
            # Two opposed dots — deliberately busier than the lower stages so
            # the top alert level is distinguishable at a glance.
            pos = ((now % period) / period) * self.count
            frame = []
            for i in range(self.count):
                d1 = min(abs(i - pos), self.count - abs(i - pos))
                d2 = min(abs(i - (pos + self.count / 2) % self.count),
                         self.count - abs(i - (pos + self.count / 2) % self.count))
                level = brightness * max(0.0, 1.0 - min(d1, d2) / 1.5)
                frame.append(_scale(base, max(level, brightness * 0.12)))
            return frame

        # Unknown pattern: solid, so a future hub sending something new still
        # produces light rather than darkness.
        return [_scale(base, brightness)] * self.count

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "available": self._available,
            "count": self.count,
            "stage": self._command.stage,
            "error": self._init_error,
        }


def _scale(color: Color, level: float) -> Color:
    level = _clamp01(level)
    return (
        int(color[0] * level),
        int(color[1] * level),
        int(color[2] * level),
    )


def _blend(a: Color, b: Color, ratio: float) -> Color:
    ratio = _clamp01(ratio)
    return (
        int(a[0] + (b[0] - a[0]) * ratio),
        int(a[1] + (b[1] - a[1]) * ratio),
        int(a[2] + (b[2] - a[2]) * ratio),
    )


def _clamp01(value: Any) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(n):
        return 0.0
    return max(0.0, min(1.0, n))


def _safe_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback
