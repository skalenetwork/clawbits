from __future__ import annotations

from datetime import datetime
from typing import cast

from eth_typing import HexStr
from eth_utils import to_bytes
from pydantic import ConfigDict, validate_call

_STRICT = ConfigDict(strict=True, validate_default=True)


@validate_call(config=_STRICT)
def parse_32b_hex_private_key(value: str) -> bytes:
    """Parse a 32-byte hex-encoded private key.

    Accepts strings with or without a 0x prefix.
    Returns the raw 32 bytes if valid, otherwise raises.
    """
    if not isinstance(value, str):
        raise TypeError(f"Expected hex string for private key, got {type(value)}")
    s = value.strip()
    if not s:
        raise ValueError("Empty private key string")
    if not s.startswith(("0x", "0X")):
        s = "0x" + s
    try:
        b = to_bytes(hexstr=cast(HexStr, s))
    except (TypeError, ValueError) as e:
        raise ValueError(f"Invalid hex private key: {value!r}") from e
    if len(b) != 32:
        raise ValueError(f"Private key must be 32 bytes, got {len(b)} bytes")
    return b


@validate_call(config=_STRICT)
def normalize_eth_address(addr: str) -> str:
    if not isinstance(addr, str):
        raise TypeError(f"Expected string for ETH address, got {type(addr)}")
    a = addr.strip().lower()
    if not a:
        raise ValueError("Empty ETH address string")
    if not a.startswith("0x"):
        a = "0x" + a
    # Strict: 20-byte address => 40 hex chars after 0x
    if len(a) != 42:
        raise ValueError(f"ETH address must be 42 chars including 0x, got {len(a)}")
    try:
        int(a[2:], 16)
    except ValueError as e:
        raise ValueError(f"ETH address contains non-hex characters: {addr!r}") from e
    return a


@validate_call(config=_STRICT)
def hex_u256_to_int(value: str) -> int:
    if not isinstance(value, str):
        raise TypeError(f"Expected hex string, got {type(value)}")
    s = value.strip().lower()
    if not s:
        raise ValueError("Empty hex string")
    if not s.startswith("0x"):
        s = "0x" + s
    try:
        n = int(s, 16)
    except ValueError as e:
        raise ValueError(f"Invalid hex literal for u256: {value!r}") from e
    if n < 0 or n >= (1 << 256):
        raise ValueError("Value out of u256 range")
    return n


def format_db_timestamp(dt: datetime | str | None) -> str | None:
    """Format a DB timestamp the way the legacy sqlite layer serialized it
    (``"YYYY-MM-DD HH:MM:SS"``). ``None``/string values pass through."""
    if dt is None or isinstance(dt, str):
        return dt
    return dt.strftime("%Y-%m-%d %H:%M:%S")


