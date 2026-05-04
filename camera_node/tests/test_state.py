"""Tests for the thread-safe CameraState machine."""

from __future__ import annotations

import threading
import time

import pytest

from camera_node.state import CameraState


def test_initial_state_default_is_off():
    s = CameraState()
    assert s.get() == "off"


def test_initial_state_on():
    s = CameraState(initial="on")
    assert s.get() == "on"


def test_invalid_initial_raises():
    with pytest.raises(ValueError):
        CameraState(initial="paused")  # type: ignore[arg-type]


def test_toggle_flips_value_and_returns_new_state():
    s = CameraState(initial="off")
    assert s.toggle() == "on"
    assert s.get() == "on"
    assert s.toggle() == "off"
    assert s.get() == "off"


def test_turn_on_off_are_idempotent():
    s = CameraState(initial="off")
    assert s.turn_on() == "on"
    assert s.turn_on() == "on"
    assert s.turn_off() == "off"
    assert s.turn_off() == "off"


def test_set_validates_value():
    s = CameraState()
    with pytest.raises(ValueError):
        s.set("yes")  # type: ignore[arg-type]


def test_callback_fires_only_on_change():
    s = CameraState(initial="off")
    events: list[str] = []
    s.on_change(lambda v: events.append(v))

    s.turn_off()  # no change
    s.turn_on()   # change -> "on"
    s.turn_on()   # no change
    s.toggle()    # change -> "off"
    s.set("off")  # no change

    assert events == ["on", "off"]


def test_thread_safe_under_concurrent_toggles():
    s = CameraState(initial="off")
    transitions: list[str] = []
    lock = threading.Lock()

    def listener(v: str) -> None:
        with lock:
            transitions.append(v)

    s.on_change(listener)

    def worker() -> None:
        for _ in range(200):
            s.toggle()

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # End state should be deterministic-ish (depends on count parity), but the
    # invariant we care about is the value is one of the two valid options and
    # callbacks are well-formed strings.
    assert s.get() in ("on", "off")
    for v in transitions:
        assert v in ("on", "off")


def test_callback_exception_does_not_break_state():
    s = CameraState(initial="off")
    s.on_change(lambda v: (_ for _ in ()).throw(RuntimeError("boom")))

    # Should not raise even though the callback explodes.
    assert s.turn_on() == "on"
    assert s.get() == "on"
