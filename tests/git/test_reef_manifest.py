"""GitHub App manifests for local and hosted Reef setup."""

import json

import pytest

from clawbits.reef_repo import manifest


@pytest.mark.parametrize(
    "base",
    ["http://localhost:8000", "http://127.0.0.1:8000", "https://app.clawbits.ai"],
)
def test_disabled_webhook_has_no_url_and_callbacks_use_instance(base: str) -> None:
    _, encoded = manifest("acme", True, base, "state")
    body = json.loads(encoded)

    assert body["hook_attributes"] == {"url": "", "active": False}
    assert body["default_events"] == []
    assert body["redirect_url"] == f"{base}/api/auth/reef/github/created"
    assert body["setup_url"] == f"{base}/api/auth/reef/github/installed"
