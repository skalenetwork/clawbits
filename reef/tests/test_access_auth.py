"""Admin-plane auth: Cloudflare Access JWT verification + the service-token path.

The verifier is exercised with a locally-generated RSA key (no network / no real
Access tenant) by injecting a stub JWKS client that returns our test public key.
"""

import datetime as dt

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient

from reef.api import security
from reef.api.access import AccessError, AccessVerifier

ISS = "https://team.cloudflareaccess.com"
AUD = "test-aud"


@pytest.fixture
def keypair() -> tuple[rsa.RSAPrivateKey, rsa.RSAPublicKey]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key, key.public_key()


def _mint(
    private_key: rsa.RSAPrivateKey,
    *,
    aud: str = AUD,
    iss: str = ISS,
    email: str = "op@acme.com",
    expired: bool = False,
) -> str:
    now = dt.datetime.now(dt.UTC)
    exp = now - dt.timedelta(minutes=5) if expired else now + dt.timedelta(minutes=5)
    return jwt.encode(
        {"aud": aud, "iss": iss, "email": email, "iat": now, "exp": exp},
        private_key,
        algorithm="RS256",
    )


class _StubKey:
    def __init__(self, key: rsa.RSAPublicKey) -> None:
        self.key = key


class _StubJWKS:
    """Stands in for jwt.PyJWKClient — returns a fixed public key, no network."""

    def __init__(self, public_key: rsa.RSAPublicKey) -> None:
        self._key = _StubKey(public_key)

    def get_signing_key_from_jwt(self, token: str) -> _StubKey:
        return self._key


def _verifier(public_key: rsa.RSAPublicKey) -> AccessVerifier:
    return AccessVerifier("team", AUD, jwks=_StubJWKS(public_key))


# ── AccessVerifier ──────────────────────────────────────────────────────────


def test_verify_valid(keypair):
    priv, pub = keypair
    claims = _verifier(pub).verify(_mint(priv))
    assert claims["email"] == "op@acme.com"


def test_verify_rejects_bad_audience(keypair):
    priv, pub = keypair
    with pytest.raises(AccessError):
        _verifier(pub).verify(_mint(priv, aud="some-other-app"))


def test_verify_rejects_expired(keypair):
    priv, pub = keypair
    with pytest.raises(AccessError):
        _verifier(pub).verify(_mint(priv, expired=True))


def test_verify_rejects_wrong_signing_key(keypair):
    priv, _ = keypair
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(AccessError):
        _verifier(other.public_key()).verify(_mint(priv))


# ── admin_auth dependency ───────────────────────────────────────────────────


def _client() -> TestClient:
    app = FastAPI()

    @app.get("/x")
    def x(request: Request, _: None = Depends(security.admin_auth)) -> dict:
        return {"operator": getattr(request.state, "operator", None)}

    return TestClient(app, raise_server_exceptions=True)


def test_open_when_nothing_configured(monkeypatch):
    monkeypatch.delenv("REEF_ADMIN_TOKEN", raising=False)
    monkeypatch.setattr(security, "get_access_verifier", lambda: None)
    assert _client().get("/x").status_code == 200


def test_service_token_required_and_accepted(monkeypatch):
    monkeypatch.setenv("REEF_ADMIN_TOKEN", "s3cret")
    monkeypatch.setattr(security, "get_access_verifier", lambda: None)
    c = _client()
    assert c.get("/x").status_code == 401
    assert c.get("/x", headers={"Authorization": "Bearer wrong"}).status_code == 401
    ok = c.get("/x", headers={"Authorization": "Bearer s3cret"})
    assert ok.status_code == 200
    assert ok.json()["operator"] == "service-token"


def test_access_jwt_accepted(monkeypatch, keypair):
    priv, pub = keypair
    monkeypatch.delenv("REEF_ADMIN_TOKEN", raising=False)
    monkeypatch.setattr(security, "get_access_verifier", lambda: _verifier(pub))
    r = _client().get("/x", headers={"Cf-Access-Jwt-Assertion": _mint(priv)})
    assert r.status_code == 200
    assert r.json()["operator"] == "op@acme.com"


def test_access_jwt_rejected(monkeypatch, keypair):
    priv, pub = keypair
    monkeypatch.delenv("REEF_ADMIN_TOKEN", raising=False)
    monkeypatch.setattr(security, "get_access_verifier", lambda: _verifier(pub))
    r = _client().get("/x", headers={"Cf-Access-Jwt-Assertion": _mint(priv, aud="bad")})
    assert r.status_code == 401


def test_service_token_still_works_when_access_enabled(monkeypatch, keypair):
    """clawbits→Reef machine path keeps working even with Access turned on."""
    _, pub = keypair
    monkeypatch.setenv("REEF_ADMIN_TOKEN", "s3cret")
    monkeypatch.setattr(security, "get_access_verifier", lambda: _verifier(pub))
    r = _client().get("/x", headers={"Authorization": "Bearer s3cret"})
    assert r.status_code == 200
    assert r.json()["operator"] == "service-token"
