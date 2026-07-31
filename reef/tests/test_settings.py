"""Operator settings: the public-URL override (persisted in settings.json), its
precedence over ``REEF_PUBLIC_URL`` (what drives agent surface links), and the
``/settings`` API. State dir is isolated per test via ``REEF_STATE_DIR``.
"""

from fastapi.testclient import TestClient

from reef import settings
from reef.api.app import create_app
from reef.fleet import FleetService
from reef.store import InMemorySandboxStore
from reef.tests.fakes import FakeAdminRuntime


def _client() -> TestClient:
    rt = FakeAdminRuntime().seed("agent-1")
    return TestClient(create_app(service=FleetService(rt, InMemorySandboxStore())))


def test_override_persists_and_clears(monkeypatch, tmp_path):
    monkeypatch.setenv("REEF_STATE_DIR", str(tmp_path))
    monkeypatch.delenv("REEF_PUBLIC_URL", raising=False)

    assert settings.get_public_url_override() is None
    assert settings.effective_public_url() is None

    settings.set_public_url_override("https://reef.example.com")
    assert settings.get_public_url_override() == "https://reef.example.com"
    assert settings.effective_public_url() == "https://reef.example.com"
    assert (tmp_path / "settings.json").exists()

    settings.set_public_url_override(None)
    assert settings.get_public_url_override() is None
    assert settings.effective_public_url() is None


def test_override_wins_over_env(monkeypatch, tmp_path):
    monkeypatch.setenv("REEF_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("REEF_PUBLIC_URL", "https://env.example.com")

    # No override yet ⇒ the env var is effective.
    assert settings.effective_public_url() == "https://env.example.com"

    # The operator override wins.
    settings.set_public_url_override("https://override.example.com")
    assert settings.effective_public_url() == "https://override.example.com"


def test_settings_endpoint_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setenv("REEF_STATE_DIR", str(tmp_path))
    monkeypatch.delenv("REEF_PUBLIC_URL", raising=False)
    monkeypatch.delenv("REEF_ADMIN_TOKEN", raising=False)
    client = _client()

    assert client.get("/settings").json() == {
        "public_url_override": None,
        "public_url_env": None,
        "public_url_effective": None,
    }

    # Set (a trailing slash is stripped by the endpoint).
    body = client.put("/settings", json={"public_url": "https://reef.example.com/"}).json()
    assert body["public_url_override"] == "https://reef.example.com"
    assert body["public_url_effective"] == "https://reef.example.com"
    assert client.get("/settings").json()["public_url_override"] == "https://reef.example.com"

    # Non-http(s) ⇒ 422.
    assert client.put("/settings", json={"public_url": "ftp://nope"}).status_code == 422
    assert client.put("/settings", json={"public_url": "just-text"}).status_code == 422

    # Clear with null.
    assert client.put("/settings", json={"public_url": None}).json()["public_url_override"] is None
