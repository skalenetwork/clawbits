"""Shared FastAPI test fixtures.

Local tests require a running Postgres — start one with
``docker compose up -d db`` before running ``pytest``.

Architecture:

- ``CLAWBITS_TEST_DATABASE_URL`` (default:
  ``postgresql+psycopg://clawbits:clawbits@localhost:5432/clawbits_test``)
  selects the shared test DB, separate from the dev DB.
- The session fixture drops the test DB schema; the app's lifespan
  recreates the tables on first ``TestClient`` entry. There are no
  pre-seeded humans or agents — tests provision themselves through the
  in-memory WorkOS adapter.
- An autouse function-scoped fixture wipes every user table between
  tests so each test sees a clean DB.
"""
from __future__ import annotations

import gc
import os

import dotenv
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlmodel import create_engine

from clawbits.datastructures.agent_id import AgentId
from clawbits.datastructures.api_key import ApiKey
from clawbits.datastructures.known_answers import get_answer_for_question
from clawbits.db import models  # noqa: F401 — ensure metadata is populated
from tests.fastapi._auth_helpers import auth_headers, login_human
from tests.fastapi._db_helpers import TEST_DATABASE_URL, ensure_database

# Tests must see the environment CI sees: a clean one. ``.env`` is gitignored,
# so it exists on developer machines and never in CI — and
# ``clawbits.fastapi.main`` calls ``load_dotenv()`` at import time, *before* its
# own clawbits imports (deliberately: modules that read env at import, like the
# attention secrets key, must see it). That makes a local ``.env`` leak into
# every import-time env read. The sharpest edge is ``CLAWBITS_ENV=development``,
# which renames the session cookie to ``fc_session_dev``; the login helper then
# reads an absent ``fc_session``, returns an empty bearer token, and requests
# silently fall back to the TestClient's cookie jar — i.e. the *wrong user*, so
# ACL tests pass a 403 check as 200 instead of failing loudly.
#
# Neutralise the loader rather than enumerate the vars: any key in ``.env``
# (dev-auth signals, LLM allow-lists, cloud creds) would otherwise change
# behavior under test. Safe to do here because ``main`` is imported lazily,
# inside the ``test_client`` fixture below, long after this module body runs —
# so its ``from dotenv import load_dotenv`` binds to this no-op.
dotenv.load_dotenv = lambda *args, **kwargs: False

# Pin the test DB URL before *any* clawbits module imports the engine.
os.environ["CLAWBITS_DATABASE_URL"] = TEST_DATABASE_URL
# Allow http cookies (TestClient runs over http://testserver).
os.environ.setdefault("CLAWBITS_INSECURE_COOKIES", "1")
# A durable secrets key, without which storing an org's LLM API key is
# (deliberately) refused — see clawbits.lobstertalk.attention.crypto.
os.environ.setdefault("CLAWBITS_ATTENTION_SECRETS_KEY", Fernet.generate_key().decode())
# Belt-and-suspenders: even if a developer has WORKOS_API_KEY in their shell,
# tests must run against the in-memory adapter — never make real HTTP calls.
os.environ.pop("WORKOS_API_KEY", None)
os.environ.pop("WORKOS_CLIENT_ID", None)


# ---------------------------------------------------------------------------
# Per-test isolation — wipe everything between tests
# ---------------------------------------------------------------------------


_ALL_TABLES_FK_ORDER = (
    "post_likes",
    "post_comments",
    "agent_posts",
    # FK to mm_posts.post_id — must wipe before mm_posts.
    "human_channel_state",
    "mm_post_reactions",
    # FK to mm_posts.post_id and mm_channels.channel_id — wipe before both.
    "mm_files",
    "mm_posts",
    # FK to mm_channels.channel_id and human_users.id / agents.agent_id —
    # wipe before mm_channels, agents, human_users.
    "mm_channel_events",
    "mm_channel_members",
    "mm_channels",
    "agent_signup_requests",
    "agent_actions",
    "agent_profiles",
    "agent_claims",
    "share_records",
    "repositories",
    "challenge_sessions",
    # FK to agents.agent_id and human_users.id — wipe before both.
    "agent_contact_permissions",
    # FK to automations.automation_id and agents.agent_id — wipe before both.
    "automation_runs",
    # FK to agents.agent_id, organizations.org_id, human_users.id — wipe first.
    "automations",
    # FK to agents.agent_id + organizations.org_id — wipe before both.
    "agent_usage_events",
    "agent_usage_daily",
    "agents",
    "org_members",
    "organizations",
    "human_users",
)


def _wipe_all(engine) -> None:
    with engine.begin() as conn:
        for table in _ALL_TABLES_FK_ORDER:
            conn.execute(text(f"DELETE FROM {table}"))


# ---------------------------------------------------------------------------
# Session-scoped setup
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def _test_engine():
    from urllib.parse import urlparse

    db_name = urlparse(TEST_DATABASE_URL).path.lstrip("/")
    ensure_database(db_name)

    engine = create_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    # Wipe everything (including alembic_version) and re-run migrations
    # ourselves. The app no longer runs ``alembic upgrade head`` from
    # inside the FastAPI lifespan (it now runs once before uvicorn forks
    # — see Dockerfile / scripts/start_server.sh) so tests are responsible for
    # bringing the schema up themselves.
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    from clawbits.db.engine import run_alembic_upgrade_head
    run_alembic_upgrade_head()
    yield engine
    engine.dispose()


@pytest.fixture(scope="session")
def test_client(_test_engine):
    """Boot the app once per session — the lifespan creates the schema.

    Replaces ``app.state.workos`` with a :class:`FakeWorkOSClient` keyed by
    the same Fernet password ``workos_auth`` uses to seal cookies, so prod's
    ``load_sealed_session`` round-trips through fake-issued tokens.
    """
    from clawbits.fastapi.main import app
    from clawbits.fastapi.workos_auth import cookie_password
    from tests.fastapi._fakes import FakeR2Client, FakeR2Presigner, FakeWorkOSClient

    app.state.workos = FakeWorkOSClient(cookie_password=cookie_password())

    with TestClient(app) as client:
        # Lifespan re-runs setup_r2() — patch the fake in *after* it returns
        # ``(None, None)`` (no Cloudflare creds in CI / hermetic test env).
        if os.getenv("USE_REAL_SERVICES") != "1":
            app._r2_client = FakeR2Client()
            app._r2_presigner = FakeR2Presigner()
            # Direct byte-upload route's data-plane client (separate from
            # the legacy shared-content client above).
            app._mm_r2 = FakeR2Client(bucket="fake-attachments-bucket")
        yield client


# ---------------------------------------------------------------------------
# Per-test cleanup
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _truncate_transient(request, _test_engine, test_client):
    """Wipe every table between tests; clear adapter in-memory state too."""
    yield
    gc.collect()
    if request.node.get_closest_marker("no_shared_db"):
        return
    _wipe_all(_test_engine)
    # Module-level chat-attachment URL cache lives outside the DB —
    # clear it so tests don't reuse signed URLs from a wiped file_id.
    from clawbits.fastapi.mm_file_helpers import clear_presigned_url_cache
    clear_presigned_url_cache()
    # Reset the fake WorkOS client so leaked users / magic codes don't
    # bleed between tests.
    from clawbits.fastapi.main import app
    from clawbits.fastapi.workos_auth import cookie_password
    from tests.fastapi._fakes import FakeWorkOSClient

    app.state.workos = FakeWorkOSClient(cookie_password=cookie_password())
    test_client.cookies.clear()


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "no_shared_db: test does not use the shared test DB; skip shared-DB cleanup",
    )


# ---------------------------------------------------------------------------
# Agent-creation helper
# ---------------------------------------------------------------------------


def _personal_org_id(test_client: TestClient, token: str) -> str:
    """Return the personal org_id for the human represented by ``token``."""
    resp = test_client.get(
        "/api/human/orgs", headers=auth_headers(token)
    )
    assert resp.status_code == 200, resp.text
    orgs = resp.json()["organizations"]
    return next(o["org_id"] for o in orgs if o["is_personal"])


def _create_agent(test_client: TestClient, owner_email: str = "stan@clawbits.ai") -> dict:
    """Two-step agent creation, with the would-be operator pre-logged-in.

    The operator-to-be is logged in first via magic auth so their personal
    org exists. The anonymous agent signup is scoped to that org, then the
    operator approves the resulting signup request — which is what binds
    ``agents.org_id`` and ``agents.operator_id``.
    """
    owner_token, _owner = login_human(test_client, owner_email)
    org_id = _personal_org_id(test_client, owner_token)

    submit_resp = test_client.post(
        "/api/agentic/agents/signup",
        json={"org_id": org_id},
    )
    assert submit_resp.status_code == 200, submit_resp.text
    challenge = submit_resp.json()
    answer = get_answer_for_question(challenge["challenge"])

    commit_resp = test_client.post(
        "/api/agentic/signup-commit",
        json={
            "session_token": challenge["session_token"],
            "challenge_response": answer,
        },
    )
    assert commit_resp.status_code == 200, commit_resp.text
    data = commit_resp.json()
    assert "signup_request_id" in data and data["signup_request_id"], data

    status_resp = test_client.get(
        f"/api/agentic/agents/signup-requests/{data['signup_request_id']}",
    )
    assert status_resp.status_code == 200, status_resp.text
    org_id = status_resp.json()["org_id"]

    approve_resp = test_client.post(
        f"/api/human/orgs/{org_id}/signup-requests/{data['signup_request_id']}/approve",
        headers=auth_headers(owner_token),
    )
    assert approve_resp.status_code == 200, approve_resp.text

    # Mint the first PoC challenge to fill the challenge cache (legacy parity).
    challenge_resp = test_client.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": f"Bearer {data['api_key']}"},
    )
    assert challenge_resp.status_code == 200, challenge_resp.text
    challenge_data = challenge_resp.json()
    challenge_answer = get_answer_for_question(challenge_data["challenge"])

    mint_resp = test_client.post(
        "/api/agentic/auth/challenge_response",
        headers={"Authorization": f"Bearer {data['api_key']}"},
        json={
            "session_token": challenge_data["session_token"],
            "challenge_response": challenge_answer,
        },
    )
    assert mint_resp.status_code == 200, mint_resp.text

    return data


@pytest.fixture(scope="function")
def api_key(test_client):
    data = _create_agent(test_client)
    test_client.agent_id = data["agent_id"]
    return data["api_key"]


@pytest.fixture(scope="function")
def create_agent_and_key(test_client: TestClient) -> tuple[AgentId, ApiKey]:
    data = _create_agent(test_client)
    return AgentId(data["agent_id"]), ApiKey(data["api_key"])
