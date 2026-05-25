"""Configuration loader for Security Lux.

Resolves the active config by merging built-in defaults with the first YAML
file found in this priority order:

    1. Path in the ``CAMERA_NODE_CONFIG`` environment variable (if set).
    2. ``/etc/camera-node/config.yml``
    3. ``./config.yml`` (current working directory).
    4. Built-in defaults only, if no file is found.

User-supplied keys override defaults; missing keys fall through to the
defaults, so partial config files are fine.
"""

from __future__ import annotations

import copy
import logging
import os
from pathlib import Path
from typing import Any

import yaml

log = logging.getLogger(__name__)

DEFAULT_CONFIG: dict[str, Any] = {
    "hub": {
        "url": "ws://meer.local:5000",
    },
    "camera": {
        "id": "front",
        "device": "/dev/video0",
        "resolution": [640, 480],
        "fps": 15,
        "jpeg_quality": 70,
    },
    "pisugar": {
        "host": "127.0.0.1",
        "port": 8423,
        "timeout_seconds": 1.0,
    },
    "logging": {
        "level": "INFO",
    },
}

DEFAULT_CONFIG_PATHS: tuple[str, ...] = (
    "/etc/camera-node/config.yml",
    "./config.yml",
)


def _deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Return a new dict with ``overlay`` merged into ``base``.

    Nested dicts are merged recursively. Lists and scalars in ``overlay``
    replace the corresponding key in ``base`` wholesale.
    """
    result = copy.deepcopy(base)
    for key, value in overlay.items():
        if (
            key in result
            and isinstance(result[key], dict)
            and isinstance(value, dict)
        ):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _candidate_paths(env: dict[str, str] | None = None) -> list[Path]:
    """Return the ordered list of paths to check for a config file."""
    env = env if env is not None else dict(os.environ)
    paths: list[Path] = []
    env_path = env.get("CAMERA_NODE_CONFIG")
    if env_path:
        paths.append(Path(env_path))
    paths.extend(Path(p) for p in DEFAULT_CONFIG_PATHS)
    return paths


def load_config(
    explicit_path: str | os.PathLike[str] | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Load configuration, merging the first existing file over defaults.

    Args:
        explicit_path: Optional path supplied by the caller (highest priority,
            bypasses env var and default locations). Mainly for tests.
        env: Environment mapping to inspect for ``CAMERA_NODE_CONFIG``. Defaults to
            ``os.environ``; accepting it explicitly keeps tests hermetic.

    Returns:
        A fully merged config dict. Always safe to ``[]``-index the top-level
        keys shown in ``DEFAULT_CONFIG``.
    """
    if explicit_path is not None:
        path = Path(explicit_path)
        overlay = _read_yaml(path) if path.is_file() else {}
        if not path.is_file():
            log.warning("Explicit config path %s does not exist; using defaults", path)
        return _deep_merge(DEFAULT_CONFIG, overlay)

    for candidate in _candidate_paths(env):
        if candidate.is_file():
            log.info("Loading config from %s", candidate)
            overlay = _read_yaml(candidate)
            return _deep_merge(DEFAULT_CONFIG, overlay)

    log.info("No config file found; using built-in defaults")
    return copy.deepcopy(DEFAULT_CONFIG)


def _read_yaml(path: Path) -> dict[str, Any]:
    """Read a YAML file; return an empty dict on empty/invalid file."""
    try:
        with path.open("r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
    except (OSError, yaml.YAMLError) as exc:
        log.error("Failed to read config %s: %s", path, exc)
        return {}
    if data is None:
        return {}
    if not isinstance(data, dict):
        log.error("Config %s top-level must be a mapping, got %s", path, type(data))
        return {}
    return data
