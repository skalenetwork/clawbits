"""Provider registry — the single place to add Notion / Gmail / etc."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ConnectorCapability = Literal["identity"]


@dataclass(frozen=True, slots=True)
class ConnectorProviderDef:
    """Static description of a connector provider.

    ``connect_modes`` documents how the provider can be linked today:
    * ``workos_sync`` — pull identity from WorkOS ``get_user_identities``
    * ``oauth_app_link`` — dedicated OAuth App (Clawbits-owned; token discarded)
    * ``oauth_link`` — generic OAuth link placeholder for future providers
    """

    id: str
    label: str
    capabilities: tuple[ConnectorCapability, ...]
    connect_modes: tuple[str, ...]
    # When False the UI shows the row as coming-soon (no Connect button).
    enabled: bool = True


CONNECTOR_PROVIDERS: dict[str, ConnectorProviderDef] = {
    "github": ConnectorProviderDef(
        id="github",
        label="GitHub",
        capabilities=("identity",),
        connect_modes=("workos_sync", "oauth_app_link"),
        enabled=True,
    ),
    # Placeholders so the Connectors page stays multi-provider shaped.
    # Flip ``enabled=True`` and wire an adapter when ready.
    "notion": ConnectorProviderDef(
        id="notion",
        label="Notion",
        capabilities=("identity",),
        connect_modes=("oauth_link",),
        enabled=False,
    ),
    "gmail": ConnectorProviderDef(
        id="gmail",
        label="Gmail",
        capabilities=("identity",),
        connect_modes=("oauth_link",),
        enabled=False,
    ),
}


def get_provider(provider_id: str) -> ConnectorProviderDef | None:
    return CONNECTOR_PROVIDERS.get(provider_id)


def list_providers() -> list[ConnectorProviderDef]:
    return list(CONNECTOR_PROVIDERS.values())
