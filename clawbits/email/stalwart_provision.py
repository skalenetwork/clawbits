"""Stalwart v0.16 mailbox provisioning via the JMAP management ("registry") API.

Domains and agent mailboxes are managed as registry objects over JMAP at
``POST {STALWART_MGMT_URL}/jmap``, authenticated with HTTP Basic as a service
account (the recovery admin) that holds the ``impersonate`` permission. The
management methods are namespaced with an ``x:`` prefix (e.g. ``x:Domain/set``,
``x:Account/set``) and require the ``urn:stalwart:jmap`` capability.

This replaces the pre-0.16 REST API (``/api/account`` etc.), which no longer
exists, and the docker-exec ``stalwart-cli`` fallback (the CLI is no longer in
the image). The same code path works identically in local dev and in a fully
containerized deployment - there is no docker dependency.

Wire contract verified against ``stalwartlabs/stalwart:v0.16.10``:
- ``x:Domain/set`` create ``{"name": "<domain>"}`` -> ``created.{cid}.id``;
  the server auto-generates DKIM/SPF/MX/DMARC records (see ``Domain.dnsZoneFile``).
- ``x:Account/set`` create ``{"@type": "User", "name": "<local>", "domainId": "<id>"}``
  -> ``created.{cid}.id``. No per-account password is set; all mailbox access is
  via admin impersonation (see ``imap_client`` / ``smtp_client``).
- duplicate create -> ``notCreated.{cid}.type == "primaryKeyViolation"`` (idempotent OK).
- ``x:Account/set`` destroy ``["<id>"]`` -> ``destroyed``.

Environment variables:
    STALWART_MGMT_URL        - JMAP base URL, no trailing /jmap
                               (compose: https://stalwart, dev bare-metal: https://localhost)
    STALWART_MGMT_VERIFY_SSL - verify the management TLS cert (default: false, internal hop)
    STALWART_SVC_USER        - service/impersonator account (default: admin = recovery admin)
    STALWART_SVC_PASSWORD    - service account password (dotenvx-encrypted in staging/prod)
"""
import logging
import os

import httpx

from clawbits.domain import EMAIL_DOMAIN

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

STALWART_MGMT_URL = os.getenv("STALWART_MGMT_URL", "https://localhost").rstrip("/")
STALWART_MGMT_VERIFY_SSL = os.getenv("STALWART_MGMT_VERIFY_SSL", "false").lower() == "true"
STALWART_SVC_USER = os.getenv("STALWART_SVC_USER", "admin")
STALWART_SVC_PASSWORD = os.getenv("STALWART_SVC_PASSWORD", "")

# JMAP management constants (verified v0.16.10)
_USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"]
_MGMT_CAPABILITY = "urn:stalwart:jmap"
# SetError types we treat as idempotent success on create.
_DUPLICATE_ERRORS = {"primaryKeyViolation"}

# Cached management account id (resolved once from the JMAP session).
_mgmt_account_id: str | None = None


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=STALWART_MGMT_URL,
        auth=(STALWART_SVC_USER, STALWART_SVC_PASSWORD),
        verify=STALWART_MGMT_VERIFY_SSL,
        timeout=10.0,
    )


def _account_id(client: httpx.Client) -> str:
    """Resolve the management account id from the JMAP session (cached)."""
    global _mgmt_account_id
    if _mgmt_account_id is None:
        resp = client.get("/jmap/session")
        resp.raise_for_status()
        primary = resp.json().get("primaryAccounts", {})
        _mgmt_account_id = primary.get(_MGMT_CAPABILITY) or next(iter(primary.values()), None)
        if _mgmt_account_id is None:
            raise RuntimeError("Stalwart session exposes no management account id")
    return _mgmt_account_id


def _invoke(client: httpx.Client, method: str, args: dict) -> dict:
    """Run a single JMAP method call and return its response arguments."""
    resp = client.post("/jmap", json={"using": _USING, "methodCalls": [[method, args, "c"]]})
    resp.raise_for_status()
    name, payload, _ = resp.json()["methodResponses"][0]
    if name == "error":
        raise RuntimeError(f"Stalwart JMAP {method} error: {payload}")
    return payload


def _domain_id(client: httpx.Client, account_id: str, domain: str) -> str | None:
    payload = _invoke(client, "x:Domain/query", {"accountId": account_id, "filter": {"name": domain}})
    ids = payload.get("ids") or []
    return ids[0] if ids else None


def _ensure_domain(client: httpx.Client, account_id: str, domain: str) -> str:
    """Return the domain's id, creating it (with auto DKIM/SPF/DMARC) if needed."""
    existing = _domain_id(client, account_id, domain)
    if existing:
        return existing
    payload = _invoke(
        client, "x:Domain/set", {"accountId": account_id, "create": {"d": {"name": domain}}}
    )
    created = payload.get("created", {}).get("d")
    if created:
        logger.info("Created Stalwart domain %s", domain)
        return created["id"]
    not_created = payload.get("notCreated", {}).get("d", {})
    if not_created.get("type") in _DUPLICATE_ERRORS:
        existing = _domain_id(client, account_id, domain)
        if existing:
            return existing
    raise RuntimeError(f"Stalwart domain create failed for {domain}: {not_created}")


def _account_id_for(client: httpx.Client, account_id: str, local: str, domain_id: str) -> str | None:
    payload = _invoke(
        client,
        "x:Account/query",
        {"accountId": account_id, "filter": {"name": local, "domainId": domain_id}},
    )
    ids = payload.get("ids") or []
    return ids[0] if ids else None


def provision_email_address(email_address: str, *, display_name: str | None = None) -> bool:
    """Ensure a Stalwart mailbox exists for ``email_address``. Idempotent.

    Returns True on success (created or already present), False otherwise.
    Accounts are created without a password; access is via admin impersonation.
    """
    if not STALWART_SVC_PASSWORD:
        logger.error("STALWART_SVC_PASSWORD is not set; cannot provision %s", email_address)
        return False

    local, _, domain = email_address.partition("@")
    local = local.lower().strip()
    domain = (domain or EMAIL_DOMAIN).lower().strip()
    if not local:
        logger.error("Cannot provision mailbox: empty local part in %r", email_address)
        return False

    try:
        with _client() as client:
            account_id = _account_id(client)
            domain_id = _ensure_domain(client, account_id, domain)

            if _account_id_for(client, account_id, local, domain_id):
                return True  # already exists

            payload = _invoke(
                client,
                "x:Account/set",
                {
                    "accountId": account_id,
                    "create": {"a": {"@type": "User", "name": local, "domainId": domain_id}},
                },
            )
            if payload.get("created", {}).get("a"):
                logger.info("Provisioned Stalwart mailbox %s@%s", local, domain)
                return True
            not_created = payload.get("notCreated", {}).get("a", {})
            if not_created.get("type") in _DUPLICATE_ERRORS:
                return True
            logger.error("Stalwart account create failed for %s: %s", email_address, not_created)
            return False
    except Exception as exc:
        logger.exception("Stalwart provisioning error for %s: %s", email_address, exc)
        return False


def provision_mailbox(agent_id: str) -> bool:
    """Ensure a mailbox exists for the given agent (``{agent_id}@{EMAIL_DOMAIN}``)."""
    return provision_email_address(f"{agent_id}@{EMAIL_DOMAIN}", display_name=agent_id)


def deprovision_mailbox(agent_id: str) -> bool:
    """Delete an agent's mailbox. Best-effort; returns True if absent or destroyed."""
    if not STALWART_SVC_PASSWORD:
        logger.error("STALWART_SVC_PASSWORD is not set; cannot deprovision %s", agent_id)
        return False
    local = agent_id.lower().strip()
    try:
        with _client() as client:
            account_id = _account_id(client)
            domain_id = _domain_id(client, account_id, EMAIL_DOMAIN.lower())
            if not domain_id:
                return True
            mailbox_id = _account_id_for(client, account_id, local, domain_id)
            if not mailbox_id:
                return True
            payload = _invoke(
                client, "x:Account/set", {"accountId": account_id, "destroy": [mailbox_id]}
            )
            if mailbox_id in (payload.get("destroyed") or []):
                logger.info("Deprovisioned Stalwart mailbox %s@%s", local, EMAIL_DOMAIN)
                return True
            logger.error(
                "Stalwart account destroy failed for %s: %s",
                agent_id,
                payload.get("notDestroyed"),
            )
            return False
    except Exception as exc:
        logger.exception("Stalwart deprovision error for %s: %s", agent_id, exc)
        return False


def domain_dns_zone(domain: str | None = None) -> str | None:
    """Return Stalwart's auto-generated DNS zone (DKIM/SPF/MX/DMARC/MTA-STS) for a domain.

    Used by the Cloudflare DNS sync to publish the records Stalwart expects.
    """
    if not STALWART_SVC_PASSWORD:
        return None
    domain = (domain or EMAIL_DOMAIN).lower()
    try:
        with _client() as client:
            account_id = _account_id(client)
            domain_id = _ensure_domain(client, account_id, domain)
            payload = _invoke(
                client,
                "x:Domain/get",
                {"accountId": account_id, "ids": [domain_id], "properties": ["dnsZoneFile"]},
            )
            items = payload.get("list") or []
            return items[0].get("dnsZoneFile") if items else None
    except Exception as exc:
        logger.exception("Stalwart dns-zone fetch error for %s: %s", domain, exc)
        return None
