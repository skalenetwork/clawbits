"""Centralised domain configuration.

Set ``CLAWBITS_ENV=production`` to use **clawbits.ai** domains.
Any other value (or unset) defaults to **freeclaws.ai** (staging /
shared infra for development).

Domains
-------
- ``BASE_DOMAIN``       – top-level domain (``freeclaws.ai`` or ``clawbits.ai``)
- ``APP_DOMAIN``        – the web app host (``app.<BASE_DOMAIN>``)
- ``APP_URL``           – origin of the web app (``https://<APP_DOMAIN>``)
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
# The web app lives on ``app.<BASE_DOMAIN>``; the apex serves the marketing
# site and 404s on every app route (see the apex cutover, 2026-08-12). Anything
# that hands a *user* a link into the app - notably the web-push payload - must
# build it from here, never from BASE_DOMAIN.
APP_DOMAIN: str = os.getenv("CLAWBITS_APP_DOMAIN", f"app.{BASE_DOMAIN}")
APP_URL: str = os.getenv("CLAWBITS_APP_URL", f"https://{APP_DOMAIN}").rstrip("/")
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
