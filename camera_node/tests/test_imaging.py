"""Tests for the geometry transforms applied before JPEG encode.

Frames here are built with an asymmetric marker so a transform that silently
does nothing, or rotates the wrong way, is caught rather than passing because
the output happened to be the right shape.
"""

from __future__ import annotations

import numpy as np
import pytest

from camera_node.imaging import (
    MAX_ZOOM,
    MIN_ZOOM,
    ImageSettings,
    apply,
    output_size,
)


def marked_frame(width: int = 640, height: int = 480) -> np.ndarray:
    """Black frame with a white block in the top-left corner only."""
    frame = np.zeros((height, width, 3), dtype=np.uint8)
    frame[0:40, 0:40] = 255
    return frame


def corner_brightness(frame: np.ndarray) -> dict[str, int]:
    """Mean intensity of each corner, for asserting where the marker ended up."""
    h, w = frame.shape[:2]
    box = 40
    return {
        "top_left": int(frame[0:box, 0:box].mean()),
        "top_right": int(frame[0:box, w - box:w].mean()),
        "bottom_left": int(frame[h - box:h, 0:box].mean()),
        "bottom_right": int(frame[h - box:h, w - box:w].mean()),
    }


def brightest_corner(frame: np.ndarray) -> str:
    corners = corner_brightness(frame)
    return max(corners, key=corners.get)


class TestIdentityFastPath:
    def test_default_settings_are_identity(self):
        assert ImageSettings().is_identity is True

    def test_identity_returns_the_same_object(self):
        # Not merely equal — an unadjusted camera must pay no copy at all.
        frame = marked_frame()
        assert apply(frame, ImageSettings()) is frame

    def test_zoom_of_exactly_one_is_still_identity(self):
        assert ImageSettings(zoom=1.0).is_identity is True

    def test_pan_alone_is_identity(self):
        # Pan has no meaning without zoom, so it must not force the slow path.
        assert ImageSettings(pan_x=0.8, pan_y=-0.4).is_identity is True

    def test_any_real_adjustment_leaves_the_fast_path(self):
        assert ImageSettings(rotation=90).is_identity is False
        assert ImageSettings(flip_horizontal=True).is_identity is False
        assert ImageSettings(flip_vertical=True).is_identity is False
        assert ImageSettings(zoom=1.5).is_identity is False

    def test_apply_tolerates_a_missing_frame(self):
        assert apply(None, ImageSettings(rotation=90)) is None


class TestRotation:
    def test_90_degrees_moves_the_marker_clockwise(self):
        rotated = apply(marked_frame(), ImageSettings(rotation=90))
        assert brightest_corner(rotated) == "top_right"

    def test_180_degrees_moves_the_marker_opposite(self):
        rotated = apply(marked_frame(), ImageSettings(rotation=180))
        assert brightest_corner(rotated) == "bottom_right"

    def test_270_degrees_moves_the_marker_anticlockwise(self):
        rotated = apply(marked_frame(), ImageSettings(rotation=270))
        assert brightest_corner(rotated) == "bottom_left"

    def test_90_and_270_swap_the_axes(self):
        frame = marked_frame(640, 480)
        for rotation in (90, 270):
            result = apply(frame, ImageSettings(rotation=rotation))
            assert result.shape[:2] == (640, 480), f"rotation={rotation}"
            assert output_size(640, 480, ImageSettings(rotation=rotation)) == (480, 640)

    def test_180_preserves_the_axes(self):
        result = apply(marked_frame(640, 480), ImageSettings(rotation=180))
        assert result.shape[:2] == (480, 640)
        assert output_size(640, 480, ImageSettings(rotation=180)) == (640, 480)

    def test_four_90_degree_rotations_return_the_original(self):
        frame = marked_frame()
        result = frame
        for _ in range(4):
            result = apply(result, ImageSettings(rotation=90))
        assert np.array_equal(result, frame)


class TestFlips:
    def test_horizontal_flip_mirrors_left_to_right(self):
        result = apply(marked_frame(), ImageSettings(flip_horizontal=True))
        assert brightest_corner(result) == "top_right"

    def test_vertical_flip_mirrors_top_to_bottom(self):
        result = apply(marked_frame(), ImageSettings(flip_vertical=True))
        assert brightest_corner(result) == "bottom_left"

    def test_both_flips_are_equivalent_to_a_180_rotation(self):
        both = apply(marked_frame(), ImageSettings(flip_horizontal=True, flip_vertical=True))
        rotated = apply(marked_frame(), ImageSettings(rotation=180))
        assert np.array_equal(both, rotated)

    def test_flip_is_its_own_inverse(self):
        frame = marked_frame()
        once = apply(frame, ImageSettings(flip_horizontal=True))
        twice = apply(once, ImageSettings(flip_horizontal=True))
        assert np.array_equal(twice, frame)


class TestZoom:
    def test_zoom_preserves_the_output_size(self):
        # The stream's dimensions must not change as someone drags the slider.
        for zoom in (1.5, 2.0, 3.3, 4.0):
            result = apply(marked_frame(640, 480), ImageSettings(zoom=zoom))
            assert result.shape[:2] == (480, 640), f"zoom={zoom}"

    def test_zooming_centre_crops_out_a_corner_marker(self):
        # The marker is in the corner, so a centred 2x zoom should lose it.
        result = apply(marked_frame(), ImageSettings(zoom=2.0))
        assert max(corner_brightness(result).values()) < 40

    def test_panning_brings_the_corner_marker_back(self):
        # Fully up and left at 2x should frame the top-left corner again.
        result = apply(marked_frame(), ImageSettings(zoom=2.0, pan_x=-1.0, pan_y=-1.0))
        assert corner_brightness(result)["top_left"] > 150

    def test_pan_is_clamped_to_the_frame(self):
        # Beyond-range pan must not read outside the array or crash.
        result = apply(marked_frame(), ImageSettings(zoom=2.0, pan_x=-1.0, pan_y=-1.0))
        clamped = apply(marked_frame(), ImageSettings.from_message(
            {"zoom": 2.0, "panX": -50, "panY": -50}
        ))
        assert np.array_equal(result, clamped)

    def test_zoom_magnifies(self):
        # A 40px marker at 2x should cover roughly 4x the area.
        frame = marked_frame()
        wide = apply(frame, ImageSettings(zoom=1.01, pan_x=-1.0, pan_y=-1.0))
        close = apply(frame, ImageSettings(zoom=2.0, pan_x=-1.0, pan_y=-1.0))
        assert (close > 128).sum() > (wide > 128).sum() * 2

    def test_extreme_zoom_still_produces_a_valid_frame(self):
        result = apply(marked_frame(), ImageSettings(zoom=MAX_ZOOM))
        assert result.shape[:2] == (480, 640)
        assert result.dtype == np.uint8


class TestOrdering:
    def test_zoom_happens_before_rotation(self):
        # Pan axes must stay in the user's frame of reference while they drag.
        # With rotation applied first, panning left would move the crop up.
        result = apply(
            marked_frame(), ImageSettings(rotation=90, zoom=2.0, pan_x=-1.0, pan_y=-1.0)
        )
        # Top-left of the *source* becomes top-right after a 90° rotation.
        assert brightest_corner(result) == "top_right"


class TestFromMessage:
    def test_reads_a_full_hub_payload(self):
        settings = ImageSettings.from_message({
            "rotation": 180, "flipHorizontal": True, "flipVertical": False,
            "zoom": 2.5, "panX": 0.5, "panY": -0.25,
        })
        assert settings.rotation == 180
        assert settings.flip_horizontal is True
        assert settings.zoom == pytest.approx(2.5)
        assert settings.pan_x == pytest.approx(0.5)

    def test_absent_keys_inherit_rather_than_reset(self):
        # Moving one slider must not clobber every other setting.
        base = ImageSettings(rotation=90, zoom=3.0, flip_vertical=True)
        updated = ImageSettings.from_message({"zoom": 2.0}, base=base)
        assert updated.zoom == pytest.approx(2.0)
        assert updated.rotation == 90
        assert updated.flip_vertical is True

    def test_out_of_range_values_are_clamped_not_rejected(self):
        settings = ImageSettings.from_message({"zoom": 99, "panX": -12, "panY": 12})
        assert settings.zoom == MAX_ZOOM
        assert settings.pan_x == -1.0
        assert settings.pan_y == 1.0

        low = ImageSettings.from_message({"zoom": 0.01})
        assert low.zoom == MIN_ZOOM

    def test_invalid_rotation_keeps_the_previous_value(self):
        base = ImageSettings(rotation=180)
        assert ImageSettings.from_message({"rotation": 45}, base=base).rotation == 180
        assert ImageSettings.from_message({"rotation": "sideways"}, base=base).rotation == 180

    def test_equivalent_rotations_are_normalised(self):
        assert ImageSettings.from_message({"rotation": 450}).rotation == 90
        assert ImageSettings.from_message({"rotation": 360}).rotation == 0

    def test_garbage_never_raises(self):
        # This arrives over the network; a malformed payload must degrade to
        # something sane rather than stopping the capture loop.
        base = ImageSettings(rotation=90, zoom=2.0)
        for payload in ({"zoom": None}, {"zoom": "loud"}, {"flipHorizontal": []},
                        {"panX": float("nan")}, {"panY": float("inf")}, {}):
            result = ImageSettings.from_message(payload, base=base)
            assert MIN_ZOOM <= result.zoom <= MAX_ZOOM
            assert -1.0 <= result.pan_x <= 1.0

        assert ImageSettings.from_message("not a dict", base=base) == base

    def test_string_booleans_are_accepted(self):
        assert ImageSettings.from_message({"flipHorizontal": "true"}).flip_horizontal is True
        assert ImageSettings.from_message({"flipHorizontal": "no"}).flip_horizontal is False

    def test_round_trips_through_to_dict(self):
        original = ImageSettings(rotation=270, flip_horizontal=True, zoom=2.5, pan_x=-0.5)
        assert ImageSettings.from_message(original.to_dict()) == original


class TestSettingsAreImmutable:
    def test_cannot_be_mutated_in_place(self):
        # The capture thread reads this without a lock, relying on it being
        # swapped wholesale rather than edited underneath it.
        settings = ImageSettings()
        with pytest.raises(Exception):
            settings.rotation = 90  # type: ignore[misc]

    def test_with_rotation_returns_a_new_object(self):
        original = ImageSettings(zoom=2.0)
        rotated = original.with_rotation(90)
        assert original.rotation == 0
        assert rotated.rotation == 90
        assert rotated.zoom == pytest.approx(2.0)
