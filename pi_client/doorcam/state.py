"""Thread-safe on/off state machine for the camera feed.

The hub-driven publisher and the capture thread both need a single source of
truth for whether the feed is currently on. ``CameraState`` centralizes that
and fires registered callbacks whenever the state actually changes, so the
camera module can open or release the hardware device in response.
"""

from __future__ import annotations

import logging
import threading
from typing import Callable, Literal

log = logging.getLogger(__name__)

StateValue = Literal["on", "off"]
StateCallback = Callable[[StateValue], None]


class CameraState:
    """Holds the feed state and notifies listeners on transitions.

    All mutating methods return the post-mutation state value so callers can
    respond to the outcome without a separate ``get()`` call.
    """

    def __init__(self, initial: StateValue = "off") -> None:
        if initial not in ("on", "off"):
            raise ValueError(f"initial must be 'on' or 'off', got {initial!r}")
        self._state: StateValue = initial
        self._lock = threading.Lock()
        self._callbacks: list[StateCallback] = []

    def get(self) -> StateValue:
        with self._lock:
            return self._state

    def turn_on(self) -> StateValue:
        return self._set("on")

    def turn_off(self) -> StateValue:
        return self._set("off")

    def toggle(self) -> StateValue:
        with self._lock:
            new_state: StateValue = "off" if self._state == "on" else "on"
            changed = new_state != self._state
            self._state = new_state
            callbacks = list(self._callbacks) if changed else []
        if changed:
            self._fire(callbacks, new_state)
        return new_state

    def set(self, value: StateValue) -> StateValue:
        """Idempotent setter. Use when the caller has an explicit target."""
        if value not in ("on", "off"):
            raise ValueError(f"value must be 'on' or 'off', got {value!r}")
        return self._set(value)

    def on_change(self, callback: StateCallback) -> None:
        """Register a listener. Called with the new state on every transition."""
        with self._lock:
            self._callbacks.append(callback)

    def _set(self, value: StateValue) -> StateValue:
        with self._lock:
            changed = value != self._state
            self._state = value
            callbacks = list(self._callbacks) if changed else []
        if changed:
            self._fire(callbacks, value)
        return value

    def _fire(self, callbacks: list[StateCallback], value: StateValue) -> None:
        for cb in callbacks:
            try:
                cb(value)
            except Exception:  # pragma: no cover - callback bugs shouldn't crash us
                log.exception("State change callback raised")
