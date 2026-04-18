"""Tests for the PiSugar response parsers and client error handling."""

from __future__ import annotations

import socket

import pytest

from doorcam.pisugar import PiSugarClient, parse_battery, parse_charging


# --------------------------- battery parser ---------------------------------


@pytest.mark.parametrize(
    "response, expected",
    [
        ("battery: 87.5\n", 87.5),
        ("battery: 100", 100.0),
        ("battery:  0.0  ", 0.0),
        ("battery: 23\n", 23.0),
    ],
)
def test_parse_battery_happy_path(response, expected):
    assert parse_battery(response) == expected


@pytest.mark.parametrize(
    "response",
    [
        "",
        "   ",
        "battery_charging: true",
        "battery: not-a-number",
        "no colon here",
        "single line\nbattery: 50",  # parser only inspects the first line
        "garbled stuff",
        "battery:",
    ],
)
def test_parse_battery_malformed_returns_none(response):
    assert parse_battery(response) is None


# --------------------------- charging parser --------------------------------


def test_parse_charging_true():
    assert parse_charging("battery_charging: true\n") is True


def test_parse_charging_false():
    assert parse_charging("battery_charging: false") is False


def test_parse_charging_case_insensitive():
    assert parse_charging("battery_charging: TRUE") is True
    assert parse_charging("battery_charging: False") is False


@pytest.mark.parametrize(
    "response",
    [
        "",
        "battery: 50",
        "battery_charging: maybe",
        "battery_charging:",
        "no colon",
    ],
)
def test_parse_charging_malformed_returns_none(response):
    assert parse_charging(response) is None


# --------------------------- client behaviour -------------------------------


def test_client_returns_none_when_daemon_unreachable():
    # 127.0.0.1:1 is reserved/unused — connection refused on Linux.
    client = PiSugarClient(host="127.0.0.1", port=1, timeout=0.2)
    assert client.get_battery() is None
    assert client.get_charging() is None


def test_client_get_battery_with_fake_daemon():
    """Spin up a tiny TCP echo server that returns a canned battery line."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(1)
    port = sock.getsockname()[1]

    import threading

    def serve() -> None:
        conn, _ = sock.accept()
        with conn:
            conn.recv(1024)
            conn.sendall(b"battery: 42.5\n")

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()

    try:
        client = PiSugarClient(host="127.0.0.1", port=port, timeout=1.0)
        assert client.get_battery() == 42.5
    finally:
        sock.close()
        thread.join(timeout=1.0)


def test_client_get_charging_with_fake_daemon():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(1)
    port = sock.getsockname()[1]

    import threading

    def serve() -> None:
        conn, _ = sock.accept()
        with conn:
            conn.recv(1024)
            conn.sendall(b"battery_charging: true\n")

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()

    try:
        client = PiSugarClient(host="127.0.0.1", port=port, timeout=1.0)
        assert client.get_charging() is True
    finally:
        sock.close()
        thread.join(timeout=1.0)
