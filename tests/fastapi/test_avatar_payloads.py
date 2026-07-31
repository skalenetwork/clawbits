"""Tests for the avatar payload helpers on the table-read layer.

Exercises :meth:`TableRead._avatar_for_member` against a real test DB
(see ``conftest.py``) because it touches the SQLModel identity map and
the avatar columns that live on ``human_users`` and ``agents``.
"""
from __future__ import annotations

import pytest
from sqlmodel import Session

from clawbits.db.models import Agent, HumanUser
from clawbits.db.table_read import TableRead


@pytest.fixture
def db_session(_test_engine):
    """Per-test session against the shared test DB.

    The autouse ``_truncate_transient`` cleanup in ``conftest.py`` wipes
    all tables AFTER each test, so each test starts on a clean slate.
    """
    with Session(_test_engine) as session:
        yield session


def test_avatar_for_member_returns_user_avatar_when_human_id_set(db_session):
    user = HumanUser(
        email="alice@example.test",
        workos_user_id="wos-alice-1",
        avatar_kind="generated",
        avatar_version=5,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    out = TableRead._avatar_for_member(
        db_session, human_id=user.id, human_row=None, agent_id=None
    )

    assert out is not None
    assert out["kind"] == "generated"
    assert out["version"] == 5
    # User-avatar URL bakes the id + version into the path.
    assert f"avatars/users/{user.id}/v5" in out["url"]


def test_avatar_for_member_uses_provided_human_row_without_extra_lookup(db_session):
    user = HumanUser(
        email="bob@example.test",
        workos_user_id="wos-bob-1",
        avatar_kind="uploaded",
        avatar_version=12,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    out = TableRead._avatar_for_member(
        db_session, human_id=user.id, human_row=user, agent_id=None
    )

    assert out is not None
    # ``uploaded`` flips the file extension to .webp in the URL.
    assert out["kind"] == "uploaded"
    assert out["version"] == 12
    assert out["url"].endswith(".webp")


def test_avatar_for_member_returns_agent_avatar_when_only_agent_id_set(db_session):
    agent = Agent(
        agent_id="dora",
        api_key_hash="hash-dora",
        eth_private_key="0x" + "a" * 64,
        nickname="Dora",
        long_name="Dora the Explorer",
        avatar_kind="generated",
        avatar_version=3,
    )
    db_session.add(agent)
    db_session.commit()

    out = TableRead._avatar_for_member(
        db_session, human_id=None, human_row=None, agent_id="dora"
    )

    assert out is not None
    assert out["kind"] == "generated"
    assert out["version"] == 3
    assert "avatars/agents/dora/v3" in out["url"]


def test_avatar_for_member_returns_none_when_both_ids_absent(db_session):
    out = TableRead._avatar_for_member(
        db_session, human_id=None, human_row=None, agent_id=None
    )
    assert out is None


def test_avatar_for_member_returns_none_when_human_row_missing(db_session):
    # human_id points at a row that doesn't exist (race: row deleted
    # between the channel read and the avatar lookup). Don't crash.
    out = TableRead._avatar_for_member(
        db_session, human_id=99999, human_row=None, agent_id=None
    )
    assert out is None


def test_avatar_for_member_returns_none_when_agent_missing(db_session):
    out = TableRead._avatar_for_member(
        db_session, human_id=None, human_row=None, agent_id="ghost-agent"
    )
    assert out is None


def test_avatar_for_member_prefers_human_over_agent_when_both_set(db_session):
    """The composite key ``(human_id, agent_id)`` shouldn't occur in
    practice, but if it does the human side wins (preserves existing
    callers' assumption that humans are checked first)."""
    user = HumanUser(
        email="carol@example.test",
        workos_user_id="wos-carol-1",
        avatar_kind="generated",
        avatar_version=7,
    )
    agent = Agent(
        agent_id="zelda",
        api_key_hash="hash-zelda",
        eth_private_key="0x" + "b" * 64,
        nickname="Zelda",
        long_name="Zelda Long",
        avatar_kind="generated",
        avatar_version=4,
    )
    db_session.add(user)
    db_session.add(agent)
    db_session.commit()
    db_session.refresh(user)

    out = TableRead._avatar_for_member(
        db_session, human_id=user.id, human_row=user, agent_id="zelda"
    )

    assert out is not None
    # Human wins — version 7, not 4.
    assert out["version"] == 7
    assert "avatars/users" in out["url"]
