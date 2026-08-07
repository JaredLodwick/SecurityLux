"""Tests for V4L2 hardware control probing.

The parser is the interesting part: `v4l2-ctl --list-ctrls` output varies by
kernel version and by webcam, and getting a control's range wrong produces a
slider that appears to do nothing over half its travel.

No camera, no v4l2-ctl and no root required — the probe is fed captured output.
"""

from __future__ import annotations

import pytest

from camera_node.controls import CameraControls, Control, parse_controls

# Real output from a UVC webcam on Linux 6.x, where several controls were
# renamed (auto_exposure was exposure_auto, white_balance_automatic was
# white_balance_temperature_auto).
MODERN_OUTPUT = """
User Controls

                     brightness 0x00980900 (int)    : min=-64 max=64 step=1 default=0 value=0
                       contrast 0x00980901 (int)    : min=0 max=64 step=1 default=32 value=32
                     saturation 0x00980902 (int)    : min=0 max=128 step=1 default=64 value=64
                            hue 0x00980903 (int)    : min=-40 max=40 step=1 default=0 value=0
        white_balance_automatic 0x0098090c (bool)   : default=1 value=1
                          gamma 0x00980910 (int)    : min=72 max=500 step=1 default=100 value=100
                           gain 0x00980913 (int)    : min=0 max=100 step=1 default=0 value=0
           power_line_frequency 0x00980918 (menu)   : min=0 max=2 default=1 value=1
      white_balance_temperature 0x0098091a (int)    : min=2800 max=6500 step=1 default=4600 value=4600 flags=inactive
                      sharpness 0x0098091b (int)    : min=0 max=6 step=1 default=3 value=3
         backlight_compensation 0x0098091c (int)    : min=0 max=2 step=1 default=1 value=1

Camera Controls

                  auto_exposure 0x009a0901 (menu)   : min=0 max=3 default=3 value=3
         exposure_time_absolute 0x009a0902 (int)    : min=1 max=5000 step=1 default=157 value=157 flags=inactive
    exposure_dynamic_framerate 0x009a0903 (bool)   : default=0 value=1
"""

# Older kernel naming, from a Pi running an earlier Raspberry Pi OS.
LEGACY_OUTPUT = """
                     brightness 0x00980900 (int)    : min=0 max=255 step=1 default=128 value=128
                       contrast 0x00980901 (int)    : min=0 max=255 step=1 default=32 value=32
  white_balance_temperature_auto 0x0098090c (bool)   : default=1 value=1
                  exposure_auto 0x009a0901 (menu)   : min=0 max=3 default=3 value=3
              exposure_absolute 0x009a0902 (int)    : min=1 max=10000 step=1 default=166 value=166
"""

MINIMAL_OUTPUT = """
                     brightness 0x00980900 (int)    : min=0 max=255 step=1 default=128 value=128
"""


def by_id(controls: list[Control]) -> dict[str, Control]:
    return {control.id: control for control in controls}


class TestParsing:
    def test_reads_range_and_current_value(self):
        control = by_id(parse_controls(MODERN_OUTPUT))["brightness"]
        assert control.kind == "int"
        assert (control.min, control.max, control.step) == (-64, 64, 1)
        assert control.default == 0
        assert control.value == 0

    def test_negative_ranges_are_read_correctly(self):
        # A camera whose brightness runs -64..64 must not be rendered as 0..64,
        # which would make half the slider travel do nothing.
        control = by_id(parse_controls(MODERN_OUTPUT))["brightness"]
        assert control.min == -64

    def test_detects_boolean_controls(self):
        control = by_id(parse_controls(MODERN_OUTPUT))["white_balance_automatic"]
        assert control.kind == "bool"
        assert control.value == 1

    def test_menu_controls_get_readable_options(self):
        control = by_id(parse_controls(MODERN_OUTPUT))["power_line_frequency"]
        assert control.kind == "menu"
        labels = [option["label"] for option in control.options]
        assert labels == ["Disabled", "50 Hz", "60 Hz"]

    def test_menu_options_span_the_reported_range_only(self):
        # This camera reports max=2, so "Auto" (3) must not be offered.
        control = by_id(parse_controls(MODERN_OUTPUT))["power_line_frequency"]
        assert all(option["value"] <= 2 for option in control.options)

    def test_inactive_controls_are_flagged(self):
        # Manual exposure is inactive while auto exposure is on. The UI greys
        # these out rather than offering a slider that silently does nothing.
        controls = by_id(parse_controls(MODERN_OUTPUT))
        assert controls["exposure_time_absolute"].inactive is True
        assert controls["white_balance_temperature"].inactive is True
        assert controls["brightness"].inactive is False

    def test_unknown_controls_are_ignored(self):
        # A webcam exposing dozens of obscure controls should not produce a
        # wall of sliders nobody understands.
        ids = set(by_id(parse_controls(MODERN_OUTPUT)))
        assert "exposure_dynamic_framerate" not in ids
        assert "hue" not in ids

    def test_legacy_control_names_map_to_the_same_ids(self):
        controls = by_id(parse_controls(LEGACY_OUTPUT))
        assert "white_balance_automatic" in controls
        assert "auto_exposure" in controls
        assert "exposure_time_absolute" in controls
        # The driver's own name is retained, since that's what we set with.
        assert controls["auto_exposure"].name == "exposure_auto"
        assert controls["exposure_time_absolute"].name == "exposure_absolute"

    def test_controls_come_back_in_a_stable_display_order(self):
        ids = [control.id for control in parse_controls(MODERN_OUTPUT)]
        assert ids.index("brightness") < ids.index("contrast")
        assert ids.index("contrast") < ids.index("saturation")
        # Auto flags sort before the manual control they gate.
        assert ids.index("auto_exposure") < ids.index("exposure_time_absolute")

    def test_a_camera_with_one_control_works(self):
        controls = parse_controls(MINIMAL_OUTPUT)
        assert len(controls) == 1
        assert controls[0].id == "brightness"

    def test_empty_or_garbage_output_yields_nothing(self):
        assert parse_controls("") == []
        assert parse_controls("no controls here\njust prose") == []

    def test_control_serialises_for_the_api(self):
        control = by_id(parse_controls(MODERN_OUTPUT))["contrast"]
        payload = control.to_dict()
        for key in ("id", "label", "kind", "min", "max", "default", "value", "inactive"):
            assert key in payload


class TestGracefulDegradation:
    def test_missing_v4l2_ctl_reports_unavailable(self, monkeypatch):
        monkeypatch.setattr("camera_node.controls.shutil.which", lambda _: None)
        controls = CameraControls("/dev/video0")
        assert controls.available is False
        assert controls.list_controls() == []

    def test_setting_a_control_without_hardware_fails_cleanly(self, monkeypatch):
        monkeypatch.setattr("camera_node.controls.shutil.which", lambda _: None)
        result = CameraControls("/dev/video0").set("brightness", 10)
        assert result["ok"] is False
        assert "unavailable" in result["error"]

    def test_apply_with_no_hardware_returns_errors_not_exceptions(self, monkeypatch):
        monkeypatch.setattr("camera_node.controls.shutil.which", lambda _: None)
        result = CameraControls("/dev/video0").apply({"brightness": 10, "contrast": 20})
        assert result["applied"] == {}
        assert set(result["errors"]) == {"brightness", "contrast"}

    def test_apply_with_nothing_to_do_is_a_no_op(self):
        assert CameraControls("/dev/video0").apply({}) == {"applied": {}, "errors": {}}

    def test_availability_is_probed_only_once(self, monkeypatch):
        calls = []
        monkeypatch.setattr("camera_node.controls.shutil.which", lambda _: "/usr/bin/v4l2-ctl")
        monkeypatch.setattr(
            CameraControls, "_run", lambda self, args: (calls.append(args), "")[1]
        )
        controls = CameraControls("/dev/video0")
        assert controls.available is True
        assert controls.available is True
        assert len(calls) == 1, "availability should be cached"


class TestSetting:
    @pytest.fixture
    def stubbed(self, monkeypatch):
        """A CameraControls wired to canned output, recording its set calls."""
        sent: list[list[str]] = []

        def fake_run(self, args):
            sent.append(args)
            if args[0] == "--list-ctrls":
                return MODERN_OUTPUT
            return ""

        monkeypatch.setattr("camera_node.controls.shutil.which", lambda _: "/usr/bin/v4l2-ctl")
        monkeypatch.setattr(CameraControls, "_run", fake_run)
        controls = CameraControls("/dev/video0")
        return controls, sent

    def test_uses_the_drivers_own_control_name(self, stubbed):
        controls, sent = stubbed
        assert controls.set("brightness", 12)["ok"] is True
        assert ["--set-ctrl", "brightness=12"] in sent

    def test_clamps_to_the_reported_range(self, stubbed):
        controls, sent = stubbed
        # v4l2-ctl clamps silently; doing it here means the value we report
        # back matches what was actually applied.
        assert controls.set("brightness", 9999)["value"] == 64
        assert controls.set("brightness", -9999)["value"] == -64

    def test_rejects_a_control_this_camera_lacks(self, stubbed):
        controls, _ = stubbed
        result = controls.set("focus_absolute", 5)
        assert result["ok"] is False
        assert "no focus_absolute" in result["error"]

    def test_rejects_a_non_numeric_value(self, stubbed):
        controls, _ = stubbed
        assert controls.set("brightness", "bright")["ok"] is False

    def test_rounds_fractional_values(self, stubbed):
        controls, _ = stubbed
        assert controls.set("brightness", 12.7)["value"] == 13

    def test_auto_flags_are_applied_before_the_controls_they_gate(self, stubbed):
        # Setting manual exposure while auto exposure is still on is silently
        # ignored by the driver — ordering is the difference between the slider
        # working and appearing to do nothing.
        controls, sent = stubbed
        controls.apply({"exposure_time_absolute": 200, "auto_exposure": 1})

        set_calls = [args[1] for args in sent if args[0] == "--set-ctrl"]
        auto_index = next(i for i, c in enumerate(set_calls) if c.startswith("auto_exposure"))
        manual_index = next(
            i for i, c in enumerate(set_calls) if c.startswith("exposure_time_absolute")
        )
        assert auto_index < manual_index

    def test_apply_reports_successes_and_failures_separately(self, stubbed):
        controls, _ = stubbed
        result = controls.apply({"brightness": 10, "focus_absolute": 3})
        assert result["applied"] == {"brightness": 10}
        assert "focus_absolute" in result["errors"]

    def test_reset_restores_every_reported_default(self, stubbed):
        controls, sent = stubbed
        controls.reset()
        set_calls = {args[1] for args in sent if args[0] == "--set-ctrl"}
        assert "brightness=0" in set_calls
        assert "contrast=32" in set_calls
        assert "gamma=100" in set_calls
