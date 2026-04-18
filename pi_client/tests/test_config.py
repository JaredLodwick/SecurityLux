"""Tests for the YAML config loader."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from doorcam.config import DEFAULT_CONFIG, load_config


def _write(path: Path, body: str) -> None:
    path.write_text(textwrap.dedent(body), encoding="utf-8")


def test_defaults_used_when_no_file_present(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("DOORCAM_CONFIG", raising=False)
    cfg = load_config(env={})
    assert cfg["server"]["port"] == DEFAULT_CONFIG["server"]["port"]
    assert cfg["camera"]["device"] == DEFAULT_CONFIG["camera"]["device"]
    assert cfg["pisugar"]["host"] == "127.0.0.1"


def test_explicit_path_overrides_defaults(tmp_path):
    cfg_file = tmp_path / "doorcam.yml"
    _write(
        cfg_file,
        """
        server:
          port: 9001
        camera:
          fps: 24
        """,
    )
    cfg = load_config(explicit_path=cfg_file)
    assert cfg["server"]["port"] == 9001
    assert cfg["camera"]["fps"] == 24
    # untouched keys must fall back to defaults
    assert cfg["server"]["host"] == DEFAULT_CONFIG["server"]["host"]
    assert cfg["camera"]["device"] == DEFAULT_CONFIG["camera"]["device"]


def test_env_var_takes_precedence_over_default_locations(tmp_path):
    env_file = tmp_path / "env-config.yml"
    _write(env_file, "server:\n  port: 7777\n")
    # Default-locations don't exist, so the env var value wins.
    cfg = load_config(env={"DOORCAM_CONFIG": str(env_file)})
    assert cfg["server"]["port"] == 7777


def test_env_var_winning_over_local_cwd_config(tmp_path, monkeypatch):
    # Both ./config.yml and DOORCAM_CONFIG exist; env var should win.
    monkeypatch.chdir(tmp_path)
    cwd_cfg = tmp_path / "config.yml"
    _write(cwd_cfg, "server:\n  port: 1111\n")
    env_cfg = tmp_path / "alt.yml"
    _write(env_cfg, "server:\n  port: 2222\n")
    cfg = load_config(env={"DOORCAM_CONFIG": str(env_cfg)})
    assert cfg["server"]["port"] == 2222


def test_partial_file_keeps_defaults_for_other_keys(tmp_path):
    cfg_file = tmp_path / "partial.yml"
    _write(cfg_file, "logging:\n  level: DEBUG\n")
    cfg = load_config(explicit_path=cfg_file)
    assert cfg["logging"]["level"] == "DEBUG"
    assert cfg["camera"]["jpeg_quality"] == DEFAULT_CONFIG["camera"]["jpeg_quality"]


def test_missing_explicit_path_falls_back_to_defaults(tmp_path):
    bogus = tmp_path / "does-not-exist.yml"
    cfg = load_config(explicit_path=bogus)
    assert cfg == DEFAULT_CONFIG


def test_invalid_yaml_falls_back_to_defaults(tmp_path):
    bad = tmp_path / "bad.yml"
    bad.write_text(":\n: not valid yaml [", encoding="utf-8")
    cfg = load_config(explicit_path=bad)
    # Loader logs and returns defaults rather than crashing the service.
    assert cfg["server"]["port"] == DEFAULT_CONFIG["server"]["port"]


def test_top_level_must_be_mapping(tmp_path):
    f = tmp_path / "list.yml"
    f.write_text("- one\n- two\n", encoding="utf-8")
    cfg = load_config(explicit_path=f)
    assert cfg == DEFAULT_CONFIG
