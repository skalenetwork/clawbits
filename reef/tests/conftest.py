"""Shared fixtures for the reef test suite."""

import pytest


@pytest.fixture(autouse=True)
def _isolated_reef_state(tmp_path, monkeypatch):
    """Surface URLs are rooted at ``effective_public_url()`` (``reef.settings``):
    the operator override persisted at ``${REEF_STATE_DIR:-~/.reef}/settings.json``,
    else the ``REEF_PUBLIC_URL`` env var. Point the state dir at a tmp dir and
    scrub the env fallback so a real ``~/.reef`` (say, a pinned tunnel URL) or a
    developer's shell can't leak into URL assertions; tests that exercise these
    set them explicitly."""
    monkeypatch.setenv("REEF_STATE_DIR", str(tmp_path / "reef-state"))
    monkeypatch.delenv("REEF_PUBLIC_URL", raising=False)


@pytest.fixture(autouse=True)
def _no_ambient_provider_keys(monkeypatch):
    """Reef-level provider keys are read live from the process env
    (``reef.providers``) - scrub them so a developer's shell can never leak
    keys into test specs or flip presence assertions."""
    monkeypatch.delenv("REEF_ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("REEF_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("REEF_GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("REEF_NEARAI_API_KEY", raising=False)
    monkeypatch.delenv("REEF_OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("REEF_OLLAMA_HOST", raising=False)
