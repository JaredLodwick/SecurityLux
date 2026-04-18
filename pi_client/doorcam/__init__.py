"""Door Cam Pi client package.

Runs on a Raspberry Pi Zero 2 W with a USB UVC webcam. Captures frames,
serves MJPEG over HTTP for LAN viewers, exposes a small control REST API,
and reports battery state from the PiSugar daemon.
"""

from .server import create_app, run_from_env

__all__ = ["create_app", "run_from_env"]
