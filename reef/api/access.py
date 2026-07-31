"""Cloudflare Access (Zero Trust) JWT verification for the admin plane.

When the Reef dashboard sits behind Cloudflare Access, every request that reaches
the origin carries a ``Cf-Access-Jwt-Assertion`` header: a short-lived RS256 JWT,
signed by Cloudflare, asserting the operator's identity *after* SSO + MFA (WorkOS
is the IdP behind Access). We verify it at the origin as defense-in-depth — the
Tunnel already means only Access-authenticated traffic should arrive, but origin
verification closes the gap if the origin is ever reached directly.

Config (both required to enable — unset ⇒ verification disabled, see ``security``):
    REEF_ACCESS_TEAM_DOMAIN   Zero Trust team domain — ``acme`` or
                              ``acme.cloudflareaccess.com``
    REEF_ACCESS_AUD           the Application Audience (AUD) tag of the Access app

Standalone-friendly: no ``clawbits`` import, and IdP-agnostic — Reef only trusts
Cloudflare's published signing keys; it never sees WorkOS.
"""

import os

import jwt


class AccessError(Exception):
    """The presented Cloudflare Access assertion is missing, invalid, or expired."""


class AccessVerifier:
    """Verifies a Cloudflare Access JWT against the team's published JWKS."""

    def __init__(self, team_domain: str, aud: str, *, jwks: jwt.PyJWKClient | None = None) -> None:
        host = team_domain if "." in team_domain else f"{team_domain}.cloudflareaccess.com"
        self.issuer = f"https://{host}"
        self.aud = aud
        # PyJWKClient fetches + caches the rotating signing keys from Cloudflare.
        self._jwks = jwks or jwt.PyJWKClient(f"{self.issuer}/cdn-cgi/access/certs")

    def verify(self, token: str) -> dict:
        """Return the validated claims, or raise ``AccessError`` (fail closed)."""
        try:
            signing_key = self._jwks.get_signing_key_from_jwt(token)
            return jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                audience=self.aud,
                issuer=self.issuer,
            )
        except jwt.PyJWTError as e:  # covers decode errors *and* JWKS-client errors
            raise AccessError(str(e)) from e


_verifier: AccessVerifier | None = None
_loaded = False


def get_access_verifier() -> AccessVerifier | None:
    """The configured verifier (built once from env), or ``None`` when the
    ``REEF_ACCESS_*`` vars aren't set (local/standalone — Access disabled)."""
    global _verifier, _loaded
    if not _loaded:
        team = os.getenv("REEF_ACCESS_TEAM_DOMAIN")
        aud = os.getenv("REEF_ACCESS_AUD")
        _verifier = AccessVerifier(team, aud) if team and aud else None
        _loaded = True
    return _verifier
