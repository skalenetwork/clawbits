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

