"""Door Cam Pi client package.

Runs on a Raspberry Pi Zero 2 W with a USB UVC webcam. Captures frames and
publishes them over a single WebSocket to the MagicMirror hub, which buffers
the latest frame and exposes it to viewers (browser, detector workers, etc.).

The publisher entry point is ``camera_node.publisher.run_from_env`` (also reachable
as ``python -m camera_node``). Submodules are imported lazily so unrelated callers
(tests, config tools) don't need ``websockets`` or ``opencv`` installed.
"""
