"""Universal human connectors — third-party identity links.

Clawbits stores **profile metadata only** (provider, external id, handle).
Never OAuth tokens, refresh tokens, or capability credentials.

Add a provider by registering it in :mod:`clawbits.connectors.registry`
and implementing a thin adapter (see :mod:`clawbits.connectors.github`).
"""
from __future__ import annotations

from clawbits.connectors.registry import (
    CONNECTOR_PROVIDERS,
    ConnectorCapability,
    ConnectorProviderDef,
    get_provider,
    list_providers,
)
from clawbits.connectors.types import ConnectorProfile

__all__ = [
    "CONNECTOR_PROVIDERS",
    "ConnectorCapability",
    "ConnectorProfile",
    "ConnectorProviderDef",
    "get_provider",
    "list_providers",
]
