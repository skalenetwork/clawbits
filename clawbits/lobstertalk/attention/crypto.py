"""Fernet sealing for org-stored LLM API keys — clawbits' first secret at rest.

Key chain: ``CLAWBITS_ATTENTION_SECRETS_KEY`` if set, else
``WORKOS_COOKIE_PASSWORD`` (the session-cookie Fernet key — mirrors
``clawbits.fastapi.workos_auth``), else an ephemeral generated key so dev/test
runs work with no env at all.

Rotation coupling: a deployment riding the cookie-password fallback MUST pin
``CLAWBITS_ATTENTION_SECRETS_KEY`` to the old value before rotating
``WORKOS_COOKIE_PASSWORD``, or stored keys become undecryptable. That degrades
loudly-but-safely: :func:`decrypt_secret` warns and returns ``None``, and
cascade triage fails open to the embedding gate verdict — agents keep getting
nudged, they just lose the LLM confirm stage until the key is re-entered.

No ephemeral fallback for *writes*. If neither variable is set there is no key
that outlives the process, and the server runs ``--workers 4`` in production:
a key sealed by one worker would be unreadable by its siblings and gone after
a restart, while the API cheerfully reported ``api_key_set: true``. So
:func:`encrypt_secret` refuses instead, and the endpoint turns that into a 503
naming the missing variable. Reads still degrade softly, and everything that
doesn't store a key (Ollama and friends) keeps working untouched.
"""

from __future__ import annotations

import logging
import os

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)


def _load_key() -> tuple[str, bool]:
    """``(key, is_stable)``. Stable means durable *and* usable as a Fernet key.

    ``WORKOS_COOKIE_PASSWORD`` is only required to be *some* secret elsewhere
    (dev auth just sha256s it), so a deployment can perfectly well be running
    with a plain passphrase there. Presence alone would then pass this check
    and every save would 500 inside ``Fernet(...)`` instead of returning the
    503 that tells the operator what to fix.
    """
    configured = os.environ.get("CLAWBITS_ATTENTION_SECRETS_KEY") or os.environ.get(
        "WORKOS_COOKIE_PASSWORD"
    )
    if configured:
        try:
            Fernet(configured.encode())
            return configured, True
        except Exception:
            logger.error(
                "the configured secrets key is not a valid Fernet key — storing "
                "LobsterTalk LLM API keys is disabled. Generate one with: python -c "
                "'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'"
            )
    else:
        logger.warning(
            "no CLAWBITS_ATTENTION_SECRETS_KEY (or WORKOS_COOKIE_PASSWORD) configured — "
            "storing LobsterTalk LLM API keys is disabled; key-less endpoints "
            "(e.g. Ollama) are unaffected"
        )
    # Generate one anyway so reads have something to fail against rather than
    # every call special-casing None. Nothing can be written under it.
    return Fernet.generate_key().decode(), False


# Read once at import, like the session-cookie key in ``workos_auth``.
_env_secrets_key, secrets_key_is_stable = _load_key()


class EphemeralSecretsKeyError(RuntimeError):
    """Raised when a secret would be sealed under a process-local key."""


def encrypt_secret(plaintext: str) -> str:
    """Seal ``plaintext`` into a Fernet token for at-rest storage.

    Raises :class:`EphemeralSecretsKeyError` when no durable key is
    configured — never store a secret that only this worker, only until
    restart, can read back. Raises on a malformed configured key too: a bad
    ``CLAWBITS_ATTENTION_SECRETS_KEY`` should fail loud at write time, not
    silently store garbage."""
    if not secrets_key_is_stable:
        raise EphemeralSecretsKeyError(
            "no durable secrets key configured (set CLAWBITS_ATTENTION_SECRETS_KEY)"
        )
    return Fernet(_env_secrets_key.encode()).encrypt(plaintext.encode()).decode()


def decrypt_secret(token: str) -> str | None:
    """Unseal a stored token; ``None`` (plus a warning) when the token doesn't
    match the current key — i.e. the key rotated without a
    ``CLAWBITS_ATTENTION_SECRETS_KEY`` pin — or the key/token is malformed.
    Callers treat ``None`` as "no key stored"."""
    try:
        return Fernet(_env_secrets_key.encode()).decrypt(token.encode()).decode()
    except InvalidToken:
        logger.warning(
            "secret decrypt failed: stored token does not match the current key "
            "(rotated WORKOS_COOKIE_PASSWORD without pinning CLAWBITS_ATTENTION_SECRETS_KEY?)"
        )
        return None
    except Exception as e:  # malformed key/token — degrade to "no key", don't crash
        logger.warning("secret decrypt failed: %s", e)
        return None
