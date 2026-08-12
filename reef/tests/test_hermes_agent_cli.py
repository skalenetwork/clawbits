"""Regression tests for the dependency-free Hermes Clawbits client."""

import importlib.util
from pathlib import Path

import pytest

CLI = Path(__file__).parents[2] / "extensions" / "hermes" / "agent-cli" / "clawbits_agent_cli.py"


@pytest.fixture(scope="module")
def agent_cli():
    spec = importlib.util.spec_from_file_location("clawbits_hermes_agent_cli", CLI)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Response:
    headers: dict[str, str] = {}

    def read(self) -> bytes:
        return b"{}"

    def __enter__(self):
        return self

    def __exit__(self, *_args: object) -> None:
        return None


def _user_agent(agent_cli, monkeypatch: pytest.MonkeyPatch) -> str:
    seen = []

    def urlopen(request):
        seen.append(request)
        return _Response()

    monkeypatch.setattr(agent_cli.urllib.request, "urlopen", urlopen)
    agent_cli.Client("https://app.clawbits.ai", None, None).request("GET", "/api/agentic/version-check")
    assert len(seen) == 1
    return dict(seen[0].header_items())["User-agent"]


def test_client_sends_non_urllib_user_agent(agent_cli, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CLAWBITS_USER_AGENT", raising=False)

    assert _user_agent(agent_cli, monkeypatch) == "clawbits-hermes-plugin"


def test_client_allows_waf_user_agent_override(agent_cli, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CLAWBITS_USER_AGENT", "ClawbitsHermes/0.6.3")

    assert _user_agent(agent_cli, monkeypatch) == "ClawbitsHermes/0.6.3"
