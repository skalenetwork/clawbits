"""Shared test helper: approve a pending agent signup request as the owner."""
from starlette.testclient import TestClient

from tests.fastapi._auth_helpers import auth_headers, login_human


def _approve_signup(
    tc: TestClient,
    data: dict,
    owner_email: str = "stan@clawbits.ai",
) -> None:
    """Log in as the owner via magic auth and approve the agent's signup."""
    token, _ = login_human(tc, owner_email)

    status_resp = tc.get(f"/api/agentic/agents/signup-requests/{data['signup_request_id']}")
    assert status_resp.status_code == 200, status_resp.text
    org_id = status_resp.json()["org_id"]

    approve_resp = tc.post(
        f"/api/human/orgs/{org_id}/signup-requests/{data['signup_request_id']}/approve",
        headers=auth_headers(token),
    )
    assert approve_resp.status_code == 200, approve_resp.text
