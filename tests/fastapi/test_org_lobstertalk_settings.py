"""Tests for the org-level LobsterTalk settings endpoints
(GET/PUT /api/human/orgs/{org_id}/lobstertalk): the full attention config in
one shape, with the API key write-only (encrypted at rest, responses carry
only ``api_key_set``)."""
import pytest
from sqlmodel import Session
from starlette.testclient import TestClient

from clawbits import ssrf
from clawbits.db.models import Organization
from clawbits.lobstertalk.attention import crypto
from clawbits.lobstertalk.attention.crypto import decrypt_secret
from clawbits.ssrf import HostResolutionError
from tests.fastapi._auth_helpers import auth_headers as _auth
from tests.fastapi._auth_helpers import register_human

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _public_dns(monkeypatch):
    """Saving a config resolves its host through the SSRF guard. Pin that to a
    public address so the suite never touches real DNS; the tests that care
    about the guard re-patch it themselves."""
    monkeypatch.setattr(ssrf, "_resolve", lambda host: {"93.184.216.34"})


def _make_org(tc: TestClient, owner_token: str, name: str) -> str:
    r = tc.post("/api/human/orgs", json={"name": name}, headers=_auth(owner_token))
    assert r.status_code == 200, r.text
    return r.json()["org_id"]


def _stored_key_token(tc: TestClient, org_id: str) -> str | None:
    """The raw attention_llm_api_key_encrypted column — a Fernet token or None."""
    with Session(tc.app._engine) as db:
        return db.get(Organization, org_id).attention_llm_api_key_encrypted


def _put(tc: TestClient, org_id: str, token: str, body: dict):
    return tc.put(
        f"/api/human/orgs/{org_id}/lobstertalk", json=body, headers=_auth(token)
    )


_CASCADE_BODY = {
    "enabled": True,
    "mode": "cascade",
    "base_url": "https://api.openai.com/v1",
    "model": "gpt-test",
}


# ---------------------------------------------------------------------------
# Tests: defaults + owner write lifecycle
# ---------------------------------------------------------------------------


def test_lobstertalk_defaults(test_client):
    """A fresh org reads back disabled, embedding mode, no LLM config."""
    owner = register_human(test_client, "lt-default-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-default-org")

    r = test_client.get(
        f"/api/human/orgs/{org_id}/lobstertalk", headers=_auth(owner["access_token"])
    )
    assert r.status_code == 200, r.text
    assert r.json() == {
        "enabled": False,
        "mode": "embedding",
        "base_url": None,
        "model": None,
        "api_key_set": False,
    }


def test_owner_cascade_round_trip_key_write_only(test_client):
    """Owner PUTs a full cascade config with a key: the response reports
    ``api_key_set`` without ever echoing the key, the DB holds ciphertext (not
    the plaintext), and decrypt_secret round-trips it."""
    owner = register_human(test_client, "lt-rt-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-rt-org")

    plaintext = "sk-super-secret-123"
    r = _put(
        test_client, org_id, owner["access_token"],
        # Trailing slash on base_url is normalized away, like reef-connection.
        {**_CASCADE_BODY, "base_url": "https://api.openai.com/v1/", "api_key": plaintext},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {
        "enabled": True,
        "mode": "cascade",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-test",
        "api_key_set": True,
    }
    assert plaintext not in r.text

    # GET reflects the same shape — still no key material.
    r = test_client.get(
        f"/api/human/orgs/{org_id}/lobstertalk", headers=_auth(owner["access_token"])
    )
    assert r.json()["api_key_set"] is True
    assert plaintext not in r.text

    # At rest: a Fernet token, not the plaintext — and it round-trips.
    token = _stored_key_token(test_client, org_id)
    assert token is not None
    assert token != plaintext and plaintext not in token
    assert decrypt_secret(token) == plaintext

    # ``enabled`` writes the same org flag the legacy /attention pair reads.
    r = test_client.get(
        f"/api/human/orgs/{org_id}/attention", headers=_auth(owner["access_token"])
    )
    assert r.json()["enabled"] is True


def test_key_preserved_when_omitted(test_client):
    """A PUT without ``api_key`` leaves the stored key untouched (write-only
    semantics: the settings form can re-save without re-entering the key)."""
    owner = register_human(test_client, "lt-keep-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-keep-org")

    r = _put(
        test_client, org_id, owner["access_token"],
        {**_CASCADE_BODY, "api_key": "sk-keep-me"},
    )
    assert r.status_code == 200, r.text
    token_before = _stored_key_token(test_client, org_id)

    r = _put(
        test_client, org_id, owner["access_token"],
        {**_CASCADE_BODY, "model": "gpt-test-2"},  # no api_key field at all
    )
    assert r.status_code == 200, r.text
    assert r.json()["model"] == "gpt-test-2"
    assert r.json()["api_key_set"] is True
    assert _stored_key_token(test_client, org_id) == token_before


def test_clear_api_key_drops_stored_key(test_client):
    owner = register_human(test_client, "lt-clear-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-clear-org")

    r = _put(
        test_client, org_id, owner["access_token"],
        {**_CASCADE_BODY, "api_key": "sk-drop-me"},
    )
    assert r.status_code == 200 and r.json()["api_key_set"] is True

    r = _put(
        test_client, org_id, owner["access_token"],
        {**_CASCADE_BODY, "clear_api_key": True},
    )
    assert r.status_code == 200, r.text
    assert r.json()["api_key_set"] is False
    assert _stored_key_token(test_client, org_id) is None


# ---------------------------------------------------------------------------
# Tests: access control
# ---------------------------------------------------------------------------


def test_member_can_read_but_not_write(test_client):
    owner = register_human(test_client, "lt-acl-owner@test.com")
    member = register_human(test_client, "lt-acl-member@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-acl-org")
    test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": "lt-acl-member@test.com", "role": "member"},
        headers=_auth(owner["access_token"]),
    )

    r = test_client.get(
        f"/api/human/orgs/{org_id}/lobstertalk", headers=_auth(member["access_token"])
    )
    assert r.status_code == 200, r.text
    assert r.json()["enabled"] is False

    r = _put(test_client, org_id, member["access_token"], {"enabled": True})
    assert r.status_code == 403


def test_outsider_cannot_read_or_write(test_client):
    owner = register_human(test_client, "lt-out-owner@test.com")
    outsider = register_human(test_client, "lt-outsider@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-out-org")

    r = test_client.get(
        f"/api/human/orgs/{org_id}/lobstertalk", headers=_auth(outsider["access_token"])
    )
    assert r.status_code == 403

    r = _put(test_client, org_id, outsider["access_token"], {"enabled": True})
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Tests: request validation
# ---------------------------------------------------------------------------


def test_put_validation_422s(test_client):
    owner = register_human(test_client, "lt-val-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-val-org")
    token = owner["access_token"]

    # Cascade mode requires base_url AND model atomically.
    r = _put(test_client, org_id, token,
             {"enabled": True, "mode": "cascade", "model": "gpt-test"})
    assert r.status_code == 422
    r = _put(test_client, org_id, token,
             {"enabled": True, "mode": "cascade", "base_url": "https://api.openai.com/v1"})
    assert r.status_code == 422

    # Non-http(s) base_url.
    r = _put(test_client, org_id, token,
             {**_CASCADE_BODY, "base_url": "ftp://llm.example.com/v1"})
    assert r.status_code == 422

    # api_key and clear_api_key are mutually exclusive.
    r = _put(test_client, org_id, token,
             {**_CASCADE_BODY, "api_key": "sk-x", "clear_api_key": True})
    assert r.status_code == 422

    # extra="forbid": unknown fields are rejected.
    r = _put(test_client, org_id, token, {"enabled": True, "surprise": 1})
    assert r.status_code == 422


def test_llm_only_round_trip_and_validation(test_client, monkeypatch):
    """llm_only saves and reads back like cascade: same atomic base_url+model
    requirement, same SSRF guard on the base URL when a request arms it."""
    owner = register_human(test_client, "lt-llmonly-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-llmonly-org")
    token = owner["access_token"]

    body = {
        "enabled": True,
        "mode": "llm_only",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-test",
    }
    r = _put(test_client, org_id, token, body)
    assert r.status_code == 200, r.text
    assert r.json()["mode"] == "llm_only" and r.json()["enabled"] is True

    r = test_client.get(
        f"/api/human/orgs/{org_id}/lobstertalk", headers=_auth(token)
    )
    assert r.status_code == 200
    assert r.json()["mode"] == "llm_only"

    # base_url AND model, atomically — like cascade.
    r = _put(test_client, org_id, token,
             {"enabled": True, "mode": "llm_only", "model": "gpt-test"})
    assert r.status_code == 422
    r = _put(test_client, org_id, token,
             {"enabled": True, "mode": "llm_only",
              "base_url": "https://api.openai.com/v1"})
    assert r.status_code == 422

    # Arming llm_only runs the same SSRF guard as arming cascade.
    monkeypatch.setattr(ssrf, "_resolve", lambda host: {"169.254.169.254"})
    r = _put(test_client, org_id, token, body)
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Tests: endpoint safety (SSRF guard, durable-key requirement)
# ---------------------------------------------------------------------------


def test_put_rejects_private_llm_endpoint(test_client, monkeypatch):
    """Org creation is self-serve, so base_url is attacker-choosable: saving
    one that resolves into the private network is refused up front."""
    monkeypatch.setattr(ssrf, "_resolve", lambda host: {"169.254.169.254"})
    owner = register_human(test_client, "lt-ssrf-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-ssrf-org")

    r = _put(
        test_client, org_id, owner["access_token"],
        {**_CASCADE_BODY, "base_url": "https://metadata.example.com/v1"},
    )
    assert r.status_code == 422
    assert "private address" in r.text

    # Nothing was written.
    r = test_client.get(
        f"/api/human/orgs/{org_id}/lobstertalk", headers=_auth(owner["access_token"])
    )
    assert r.json()["mode"] == "embedding"


def test_put_rejects_plain_http_endpoint(test_client):
    """Channel text over cleartext is refused at the endpoint too, not just in
    the guard's own unit tests."""
    owner = register_human(test_client, "lt-http-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-http-org")

    r = _put(
        test_client, org_id, owner["access_token"],
        {**_CASCADE_BODY, "base_url": "http://api.example.com/v1"},
    )
    assert r.status_code == 422
    assert "plain http" in r.text


def test_owner_can_always_disable_even_with_a_now_unsafe_endpoint(test_client, monkeypatch):
    """A saved host can go bad later (repointed into RFC1918). Turning
    LobsterTalk off is exactly when you most need it to work, so the endpoint
    check only runs for a request that actually arms cascade."""
    owner = register_human(test_client, "lt-lockout-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-lockout-org")

    r = _put(test_client, org_id, owner["access_token"], _CASCADE_BODY)
    assert r.status_code == 200, r.text

    # The host now resolves somewhere private.
    monkeypatch.setattr(ssrf, "_resolve", lambda host: {"10.0.0.5"})

    r = _put(
        test_client, org_id, owner["access_token"],
        {**_CASCADE_BODY, "enabled": False},  # same config, just switched off
    )
    assert r.status_code == 200, r.text
    assert r.json()["enabled"] is False


def test_put_allows_unresolvable_host(test_client, monkeypatch):
    """A name this host can't resolve yet (split-horizon DNS, endpoint not up)
    saves fine — the call-time check is what refuses to dial."""
    def _boom(host):
        raise HostResolutionError("DNS lookup failed: no such host")

    monkeypatch.setattr(ssrf, "_resolve", _boom)
    owner = register_human(test_client, "lt-dns-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-dns-org")

    r = _put(
        test_client, org_id, owner["access_token"],
        {**_CASCADE_BODY, "base_url": "https://not-up-yet.example.com/v1"},
    )
    assert r.status_code == 200, r.text


def test_put_refuses_api_key_without_durable_secrets_key(test_client, monkeypatch):
    """The server runs multiple workers: a key sealed under a process-local
    key would be unreadable by its siblings and gone after a restart. Refuse
    rather than report api_key_set on a key nobody can read back."""
    monkeypatch.setattr(crypto, "secrets_key_is_stable", False)
    monkeypatch.setattr(ssrf, "_resolve", lambda host: {"93.184.216.34"})
    owner = register_human(test_client, "lt-nokey-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-nokey-org")

    r = _put(
        test_client, org_id, owner["access_token"], {**_CASCADE_BODY, "api_key": "sk-x"}
    )
    assert r.status_code == 503
    assert "CLAWBITS_ATTENTION_SECRETS_KEY" in r.text
    assert _stored_key_token(test_client, org_id) is None

    # Key-less endpoints (Ollama and friends) are unaffected.
    r = _put(test_client, org_id, owner["access_token"], _CASCADE_BODY)
    assert r.status_code == 200, r.text
    assert r.json()["api_key_set"] is False


def test_invalid_secrets_key_is_refused_not_a_500(test_client, monkeypatch):
    """WORKOS_COOKIE_PASSWORD only has to be *some* secret for the rest of the
    app, so a deployment can be running with a plain passphrase there. That
    must produce the same actionable 503, not a Fernet crash."""
    monkeypatch.setattr(crypto, "secrets_key_is_stable", False)
    owner = register_human(test_client, "lt-badkey-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-badkey-org")

    r = _put(
        test_client, org_id, owner["access_token"], {**_CASCADE_BODY, "api_key": "sk-x"}
    )
    assert r.status_code == 503
    assert "CLAWBITS_ATTENTION_SECRETS_KEY" in r.text


def test_api_key_set_reports_usable_not_merely_stored(test_client, monkeypatch):
    """A ciphertext orphaned by a rotated secrets key can't be decrypted, so
    cascade runs without it. Reporting "set" would tell the owner everything
    is fine while asking them to fix nothing."""
    owner = register_human(test_client, "lt-orphan-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-orphan-org")

    r = _put(
        test_client, org_id, owner["access_token"], {**_CASCADE_BODY, "api_key": "sk-live"}
    )
    assert r.status_code == 200 and r.json()["api_key_set"] is True

    # Simulate the rotation: the stored token no longer matches the key.
    with Session(test_client.app._engine) as db:
        org = db.get(Organization, org_id)
        org.attention_llm_api_key_encrypted = (
            "gAAAAABmb2d1cy10b2tlbi10aGF0LWRvZXMtbm90LWRlY3J5cHQ="
        )
        db.add(org)
        db.commit()

    r = test_client.get(
        f"/api/human/orgs/{org_id}/lobstertalk", headers=_auth(owner["access_token"])
    )
    assert r.status_code == 200
    assert r.json()["api_key_set"] is False  # honest: re-enter the key


# ---------------------------------------------------------------------------
# Tests: the healthcheck probe endpoint
# ---------------------------------------------------------------------------


def _hc(tc: TestClient, org_id: str, token: str):
    return tc.post(
        f"/api/human/orgs/{org_id}/lobstertalk/healthcheck", headers=_auth(token)
    )


def test_healthcheck_probes_stored_config(test_client, monkeypatch):
    """Happy path: the probe runs against the stored config and its verdict
    (plus latency) comes back verbatim. The probe itself is faked — its real
    behavior is covered in test_lobstertalk_triage.py."""
    import clawbits.fastapi.human_endpoints as he

    owner = register_human(test_client, "lt-hc-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-hc-org")
    token = owner["access_token"]
    assert _put(test_client, org_id, token, _CASCADE_BODY).status_code == 200

    seen: list = []

    async def _fake_probe(config):
        seen.append(config)
        return True, f"{config.model} answered correctly"

    monkeypatch.setattr(he, "probe_llm_endpoint", _fake_probe)
    r = _hc(test_client, org_id, token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert "gpt-test" in body["detail"]
    assert isinstance(body["latency_ms"], int)
    assert seen[0].base_url == _CASCADE_BODY["base_url"]


def test_healthcheck_reports_probe_failure_as_200(test_client, monkeypatch):
    """A failing endpoint is a *finding*, not an HTTP error: 200 with ok=false
    so the UI renders the detail instead of a generic error toast."""
    import clawbits.fastapi.human_endpoints as he

    owner = register_human(test_client, "lt-hc-fail-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-hc-fail-org")
    token = owner["access_token"]
    assert _put(test_client, org_id, token, _CASCADE_BODY).status_code == 200

    async def _fake_probe(config):
        return False, "Error code: 401 - invalid_api_key"

    monkeypatch.setattr(he, "probe_llm_endpoint", _fake_probe)
    r = _hc(test_client, org_id, token)
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert "401" in r.json()["detail"]


def test_healthcheck_owner_only_and_needs_an_endpoint(test_client):
    owner = register_human(test_client, "lt-hc-gate-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-hc-gate-org")

    # Fresh org: embedding mode — nothing to probe.
    r = _hc(test_client, org_id, owner["access_token"])
    assert r.status_code == 422

    member = register_human(test_client, "lt-hc-gate-member@test.com")
    test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": "lt-hc-gate-member@test.com", "role": "member"},
        headers=_auth(owner["access_token"]),
    )
    assert _hc(test_client, org_id, member["access_token"]).status_code == 403


def test_healthcheck_undecryptable_key_fails_without_dialing(test_client, monkeypatch):
    """A stored-but-undecryptable key (rotated secrets key) is reported as a
    finding — the endpoint is never dialed with a key we know is wrong."""
    import clawbits.fastapi.human_endpoints as he

    owner = register_human(test_client, "lt-hc-rot-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "lt-hc-rot-org")
    token = owner["access_token"]
    assert _put(test_client, org_id, token, _CASCADE_BODY).status_code == 200
    with Session(test_client.app._engine) as db:
        org = db.get(Organization, org_id)
        org.attention_llm_api_key_encrypted = "not-a-fernet-token"
        db.add(org)
        db.commit()

    async def _boom(config):
        raise AssertionError("probe must not run with an undecryptable key")

    monkeypatch.setattr(he, "probe_llm_endpoint", _boom)
    r = _hc(test_client, org_id, token)
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert "decrypted" in r.json()["detail"]
