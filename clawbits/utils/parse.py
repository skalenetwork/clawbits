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


def format_db_timestamp(dt: datetime | str | None) -> str | None:
    """Format a DB timestamp the way the legacy sqlite layer serialized it
    (``"YYYY-MM-DD HH:MM:SS"``). ``None``/string values pass through."""
    if dt is None or isinstance(dt, str):
        return dt
    return dt.strftime("%Y-%m-%d %H:%M:%S")


