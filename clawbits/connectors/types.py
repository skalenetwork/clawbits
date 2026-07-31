"""Shared types for connector adapters."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class ConnectorProfile:
    """Non-secret profile pulled from a provider after connect/sync.

    Tokens must never appear here.
    """

    provider: str
    external_id: str
    handle: str | None = None
    display_name: str | None = None
    avatar_url: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
