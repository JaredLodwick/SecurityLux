"""Tests for CameraManager's device-stall detection and reopen logic.

Covers the bug behind a wedged USB webcam: `_capture_loop` used to retry a
failed `cap.read()` silently forever, with nothing logged and no attempt to
recover. These drive `_capture_loop` directly with a fake capture object so
no real V4L2 device is needed.
"""

from __future__ import annotations

import threading
import time

import numpy as np
import pytest

from camera_node.camera import CameraConfig, CameraManager
from camera_node.state import CameraState

_A_FRAME = np.zeros((48, 64, 3), dtype=np.uint8)


class FakeCapture:
    """Stands in for cv2.VideoCapture. `reads` is a queue of ok/frame pairs."""

    def __init__(self, reads):
        self._reads = list(reads)
        self.released = False

    def read(self):
        if self._reads:
            return self._reads.pop(0)
        return True, _A_FRAME

    def release(self):
        self.released = True


def make_manager():
    cfg = CameraConfig(device="/dev/fake0", width=64, height=48, fps=100)
    return CameraManager(cfg, CameraState(initial="off"))


def run_briefly(manager: CameraManager, seconds: float) -> None:
    """Run `_capture_loop` in a background thread for a bit, then stop it."""
    manager._stop_event.clear()
    t = threading.Thread(target=manager._capture_loop, daemon=True)
    t.start()
    time.sleep(seconds)
    manager._stop_event.set()
    t.join(timeout=2.0)
    assert not t.is_alive()


def test_stalled_read_is_logged(monkeypatch, caplog):
    """A real device that stops returning frames must show up in the log."""
    manager = make_manager()
    capture = FakeCapture([(False, None)] * 100000)  # never succeeds
    monkeypatch.setattr(manager, "_open_device", lambda: capture)
    # Fire the stall-log path almost immediately instead of waiting 2s.
    monkeypatch.setattr("camera_node.camera.STALL_LOG_INTERVAL_S", 0.05)
    monkeypatch.setattr("camera_node.camera.DEVICE_REOPEN_AFTER_S", 999.0)

    with caplog.at_level("WARNING", logger="camera_node.camera"):
        run_briefly(manager, 0.3)

    assert any("No frame from" in r.message for r in caplog.records)


def test_stalled_device_is_reopened(monkeypatch):
    """After the reopen threshold, the wedged handle is released and replaced."""
    manager = make_manager()
    first = FakeCapture([(False, None)] * 100000)
    second = FakeCapture([(True, _A_FRAME)] * 100000)
    opens = [first, second]
    monkeypatch.setattr(manager, "_open_device", lambda: opens.pop(0))
    monkeypatch.setattr("camera_node.camera.STALL_LOG_INTERVAL_S", 999.0)
    monkeypatch.setattr("camera_node.camera.DEVICE_REOPEN_AFTER_S", 0.05)
    monkeypatch.setattr("camera_node.camera.DEVICE_REOPEN_RETRY_S", 999.0)

    run_briefly(manager, 0.3)

    assert first.released is True
    assert manager.using_mock() is False


def test_reopen_falls_back_to_mock_when_device_wont_reopen(monkeypatch):
    """If the reopen itself fails, the mock frame keeps the feed visibly alive."""
    manager = make_manager()
    first = FakeCapture([(False, None)] * 100000)
    monkeypatch.setattr(manager, "_open_device", lambda: first if not first.released else None)
    monkeypatch.setattr("camera_node.camera.STALL_LOG_INTERVAL_S", 999.0)
    monkeypatch.setattr("camera_node.camera.DEVICE_REOPEN_AFTER_S", 0.05)
    monkeypatch.setattr("camera_node.camera.DEVICE_REOPEN_RETRY_S", 999.0)

    manager._stop_event.clear()
    t = threading.Thread(target=manager._capture_loop, daemon=True)
    t.start()
    try:
        time.sleep(0.3)
        assert first.released is True
        assert manager.using_mock() is True
        # The mock frame keeps flowing even though the real device never came back.
        assert manager.get_latest_jpeg(wait_seconds=0.5) is not None
    finally:
        manager._stop_event.set()
        t.join(timeout=2.0)
        assert not t.is_alive()


def test_never_had_hardware_does_not_spin_retrying(monkeypatch):
    """The laptop-dev case (no device at all) shouldn't try to reopen forever."""
    manager = make_manager()
    monkeypatch.setattr(manager, "_open_device", lambda: None)
    reopen_calls = []
    orig = CameraManager._reopen_device
    monkeypatch.setattr(
        CameraManager, "_reopen_device",
        lambda self, capture: reopen_calls.append(1) or orig(self, capture),
    )

    run_briefly(manager, 0.2)

    assert reopen_calls == []
    assert manager.using_mock() is True
