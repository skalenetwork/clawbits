"""Centralised domain configuration.

Set ``CLAWBITS_ENV=production`` to use **clawbits.ai** domains.
Any other value (or unset) defaults to **freeclaws.ai** (staging /
shared infra for development).

Domains
-------
- ``BASE_DOMAIN``       – top-level domain (``freeclaws.ai`` or ``clawbits.ai``)
- ``SHARE_DOMAIN``      – R2 public file hosting (``share.<BASE_DOMAIN>``)
- ``EMAIL_DOMAIN``      – agent email addresses (``<agent>@<BASE_DOMAIN>``)
- ``SYSTEM_EMAIL``      – system git-commit author email

Note: there is no ``clawbits.io`` zone — the previous default predated
the project rename and pointed at a domain the project never owned.
Local dev shares the staging share-domain unless ``CUSTOM_DOMAIN`` is
set to override.
"""

import os

CLAWBITS_ENV: str = os.getenv("CLAWBITS_ENV", "development")
IS_PRODUCTION: bool = CLAWBITS_ENV == "production"

# Top-level domain
BASE_DOMAIN: str = "clawbits.ai" if IS_PRODUCTION else "freeclaws.ai"

# Sub-domains / derived
SHARE_DOMAIN: str = os.getenv("CUSTOM_DOMAIN", f"share.{BASE_DOMAIN}")
EMAIL_DOMAIN: str = os.getenv("STALWART_EMAIL_DOMAIN", BASE_DOMAIN)
SYSTEM_EMAIL: str = f"system@{BASE_DOMAIN}"


# ---------------------------------------------------------------------------
# Environment gate for debug-only surfaces
# ---------------------------------------------------------------------------
# Environments that count as "development" for security gates. A gate keyed on
# this set fails CLOSED: unset / empty / unknown ``CLAWBITS_ENV`` is NOT dev.
#
# Contrast ``IS_PRODUCTION`` above, which is evaluated at import time and fails
# OPEN (unset -> "development" -> not production). That constant is a
# *domain-selection* switch and must never be used as a security gate — reach
# for ``is_dev_env()`` for anything safety-relevant.
DEV_ENVS = frozenset({"development", "dev", "local", "test"})


def is_dev_env() -> bool:
    """True when ``CLAWBITS_ENV`` names a development environment.

    Reads ``os.environ`` on every call — deliberately *not* the module-level
    ``CLAWBITS_ENV`` constant, which is frozen at import time and would make
    every gate built on this untestable.
    """
    return (os.environ.get("CLAWBITS_ENV") or "").strip().lower() in DEV_ENVS
