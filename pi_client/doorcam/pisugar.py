"""Client for the PiSugar battery daemon.

PiSugar ships a small local TCP server (default ``127.0.0.1:8423``). You send
a plain-text command line (e.g. ``get battery\\n``) and it replies with a
single line like ``battery: 87.5``. No TLS, no auth, assumed loopback-only.

All network errors are swallowed and surfaced as ``None`` return values — this
is a best-effort telemetry source, not a critical path, so callers shouldn't
have to wrap every call in a try/except.
"""

from __future__ import annotations

import logging
import socket
from typing import Optional

log = logging.getLogger(__name__)


def parse_battery(response: str) -> Optional[float]:
    """Extract the float percentage from a ``battery: 87.5`` line.

    Returns None for anything malformed, empty, or non-numeric.
    """
    if not response:
        return None
    line = response.strip().splitlines()[0] if response.strip() else ""
    if ":" not in line:
        return None
    key, _, value = line.partition(":")
    if key.strip() != "battery":
        return None
    try:
        return float(value.strip())
    except (ValueError, AttributeError):
        return None


def parse_charging(response: str) -> Optional[bool]:
    """Extract the boolean from a ``battery_charging: true|false`` line."""
    if not response:
        return None
    line = response.strip().splitlines()[0] if response.strip() else ""
    if ":" not in line:
        return None
    key, _, value = line.partition(":")
    if key.strip() != "battery_charging":
        return None
    token = value.strip().lower()
    if token == "true":
        return True
    if token == "false":
        return False
    return None


class PiSugarClient:
    """Best-effort client for the PiSugar TCP daemon.

    Every network call opens a fresh short-lived socket. That's slightly
    wasteful but keeps the lifecycle trivial and sidesteps any reconnect
    bookkeeping; the daemon is on localhost so the overhead is negligible.
    """

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 8423,
        timeout: float = 1.0,
    ) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout

    def get_battery(self) -> Optional[float]:
        raw = self._send("get battery\n")
        if raw is None:
            return None
        return parse_battery(raw)

    def get_charging(self) -> Optional[bool]:
        raw = self._send("get battery_charging\n")
        if raw is None:
            return None
        return parse_charging(raw)

    def _send(self, command: str) -> Optional[str]:
        """Send a command line and read a short response. Returns None on any error."""
        try:
            with socket.create_connection((self.host, self.port), timeout=self.timeout) as sock:
                sock.settimeout(self.timeout)
                sock.sendall(command.encode("ascii"))
                chunks: list[bytes] = []
                # The daemon typically replies with a single short line; read a
                # modest amount and stop at the first newline or EOF.
                while True:
                    data = sock.recv(1024)
                    if not data:
                        break
                    chunks.append(data)
                    if b"\n" in data or sum(len(c) for c in chunks) > 4096:
                        break
                return b"".join(chunks).decode("ascii", errors="replace")
        except (OSError, socket.timeout) as exc:
            log.debug("PiSugar %s:%s unreachable (%s)", self.host, self.port, exc)
            return None
