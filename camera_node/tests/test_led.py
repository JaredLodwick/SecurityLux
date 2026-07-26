"""Tests for the NeoPixel door light.

These exercise the animation maths and the TTL dead-man's switch, all of which
are pure Python. No strip, no SPI bus, and no Adafruit libraries are required —
which is also the point of the first test: a camera with no LED hardware must
keep working exactly as before.
"""

from __future__ import annotations

import time

import pytest

from camera_node.led import LedCommand, LedController


def make_controller(**kwargs) -> LedController:
    defaults = {"count": 8, "enabled": True, "max_brightness": 0.4}
    defaults.update(kwargs)
    return LedController(**defaults)


class TestGracefulDegradation:
    def test_setup_fails_softly_without_hardware(self):
        # There is no SPI bus on a dev machine. This must be a no-op, not a crash.
        controller = make_controller()
        assert controller.setup() is False
        assert controller.available is False

    def test_disabled_controller_never_tries_to_initialise(self):
        controller = make_controller(enabled=False)
        assert controller.setup() is False
        assert controller.status()["enabled"] is False

    def test_submit_is_safe_with_no_hardware(self):
        controller = make_controller()
        controller.submit({"pattern": "pulse", "color": [255, 0, 0], "brightness": 1.0})
        # Nothing raised, and nothing claims to be driving a strip.
        assert controller.available is False

    def test_teardown_is_safe_when_never_set_up(self):
        make_controller().teardown()


class TestCommandParsing:
    def test_parses_a_hub_message(self):
        command = LedCommand.from_message({
            "pattern": "chase", "color": [255, 70, 20], "brightness": 0.9,
            "periodMs": 650, "stage": 4, "ttlMs": 8000,
        })
        assert command.pattern == "chase"
        assert command.color == (255, 70, 20)
        assert command.brightness == pytest.approx(0.9)
        assert command.period_ms == 650
        assert command.stage == 4

    def test_survives_a_malformed_message(self):
        command = LedCommand.from_message({
            "pattern": "pulse", "color": "not-a-colour",
            "brightness": "loud", "periodMs": None, "stage": "x",
        })
        assert command.color == (0, 0, 0)
        assert command.brightness == 0.0
        assert command.stage == 0

    def test_brightness_is_clamped_to_the_valid_range(self):
        assert LedCommand.from_message({"brightness": 5.0}).brightness == 1.0
        assert LedCommand.from_message({"brightness": -2.0}).brightness == 0.0


class TestTimeToLive:
    """The dead-man's switch.

    If the hub crashes mid-event or WiFi drops while someone is at the door,
    the failure mode has to be "the light goes out", not "the light stays on
    all night".
    """

    def test_a_command_expires_after_its_ttl(self):
        command = LedCommand(ttl_ms=20)
        assert command.expired is False
        time.sleep(0.05)
        assert command.expired is True

    def test_zero_ttl_never_expires(self):
        # Idle has nothing to decay to, so it is held indefinitely.
        command = LedCommand(ttl_ms=0)
        time.sleep(0.02)
        assert command.expired is False


class TestRendering:
    def test_off_renders_every_pixel_dark(self):
        controller = make_controller()
        frame = controller._render(LedCommand(pattern="off"), now=1.0)
        assert frame == [(0, 0, 0)] * 8

    def test_brightness_is_capped_by_the_controller(self):
        # The hub asks for full brightness; the camera's own cap wins. Eight
        # LEDs at full white draw ~480 mA, which the Pi Zero's rail should not
        # be asked for while a PiSugar is charging.
        controller = make_controller(max_brightness=0.4)
        command = LedCommand(pattern="solid", color=(255, 255, 255), brightness=1.0)
        frame = controller._render(command, now=1.0)
        assert max(max(pixel) for pixel in frame) <= int(255 * 0.4) + 1

    def test_solid_is_uniform(self):
        controller = make_controller()
        command = LedCommand(pattern="solid", color=(200, 100, 50), brightness=0.4)
        frame = controller._render(command, now=1.0)
        assert len(set(frame)) == 1

    def test_breathe_varies_over_time_but_stays_lit(self):
        controller = make_controller()
        command = LedCommand(pattern="breathe", color=(255, 200, 140),
                             brightness=0.4, period_ms=2600)
        samples = [max(controller._render(command, now=t)[0]) for t in (0.0, 0.65, 1.3, 1.95)]
        assert len(set(samples)) > 1, "a breathe animation must actually change"
        assert all(level > 0 for level in samples), "breathe should not go fully dark"

    def test_sweep_lights_different_pixels_over_time(self):
        controller = make_controller()
        command = LedCommand(pattern="sweep", color=(90, 190, 255),
                             brightness=0.4, period_ms=1400)
        first = controller._render(command, now=0.0)
        later = controller._render(command, now=0.7)
        assert first != later
        # A comet, not a wash: only part of the strip is lit at once.
        assert any(pixel == (0, 0, 0) for pixel in first)

    def test_chase_keeps_a_dim_floor_so_the_strip_reads_as_active(self):
        controller = make_controller()
        command = LedCommand(pattern="chase", color=(255, 70, 20),
                             brightness=1.0, period_ms=650)
        frame = controller._render(command, now=0.3)
        assert all(max(pixel) > 0 for pixel in frame)

    def test_higher_stages_are_at_least_as_bright(self):
        controller = make_controller(max_brightness=1.0)
        present = controller._render(
            LedCommand(pattern="breathe", color=(255, 200, 140), brightness=0.65,
                       period_ms=2600), now=0.65)
        loitering = controller._render(
            LedCommand(pattern="chase", color=(255, 70, 20), brightness=1.0,
                       period_ms=650), now=0.0)
        assert max(max(p) for p in loitering) >= max(max(p) for p in present)

    def test_unknown_pattern_falls_back_to_solid(self):
        # A future hub sending a new pattern should still produce light.
        controller = make_controller()
        command = LedCommand(pattern="something-new", color=(10, 20, 30), brightness=0.4)
        frame = controller._render(command, now=1.0)
        assert all(pixel == frame[0] for pixel in frame)
        assert max(frame[0]) > 0

    def test_frame_length_follows_the_configured_led_count(self):
        for count in (1, 8, 30):
            controller = make_controller(count=count)
            frame = controller._render(
                LedCommand(pattern="solid", color=(255, 255, 255), brightness=0.4), now=0.0)
            assert len(frame) == count


class TestConfigUpdates:
    def test_apply_config_updates_count_and_brightness(self):
        controller = make_controller(count=8, enabled=False)
        controller.apply_config({"enabled": False, "count": 16, "maxBrightness": 0.75})
        assert controller.count == 16
        assert controller.max_brightness == pytest.approx(0.75)

    def test_apply_config_can_disable_the_light(self):
        controller = make_controller(enabled=True)
        controller.apply_config({"enabled": False, "count": 8, "maxBrightness": 0.4})
        assert controller.enabled is False
        assert controller.available is False

    def test_status_reports_the_error_after_a_failed_setup(self):
        controller = make_controller()
        controller.setup()
        status = controller.status()
        assert status["available"] is False
        assert status["error"], "a failure reason should be surfaced for the dashboard"
