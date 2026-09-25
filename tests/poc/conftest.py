import pytest


@pytest.fixture(autouse=True)
def _isolate_hermes_home(monkeypatch, tmp_path):
    """Point HERMES_HOME at a temp dir for every poc test.

    The adapter persists durable state there (the read-cursor map, the email
    watermark, the greeting marker), and a first-boot poll in a test would
    otherwise write into the developer's real ``~/.hermes``."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    yield
