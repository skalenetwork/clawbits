"""Boot-time validation of WorkOS client construction.

The WorkOS hosted UI returns an opaque "Invalid client ID" error when
sent a client_id it doesn't recognise — including the literal
``__REPLACE_WITH_PROD_WORKOS_CLIENT_ID__`` placeholder string that
ships in :file:`.env.example` and gets copied (and forgotten) into
real env files. We refuse to boot on those rather than letting the
error surface at first OAuth click.
"""
from __future__ import annotations

import pytest

from clawbits.fastapi.workos_auth import make_workos_client


def _set_env(monkeypatch: pytest.MonkeyPatch, **values: str | None) -> None:
    for k, v in values.items():
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)


def test_no_api_key_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without ``WORKOS_API_KEY`` the construction is a no-op (tests path)."""
    _set_env(monkeypatch, WORKOS_API_KEY=None, WORKOS_CLIENT_ID=None)
    assert make_workos_client() is None


def test_missing_client_id_refuses_boot(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_env(
        monkeypatch,
        WORKOS_API_KEY="sk_test_x",
        WORKOS_CLIENT_ID=None,
        WORKOS_COOKIE_PASSWORD="x" * 44,
    )
    with pytest.raises(RuntimeError, match="WORKOS_CLIENT_ID is missing"):
        make_workos_client()


def test_placeholder_client_id_refuses_boot(monkeypatch: pytest.MonkeyPatch) -> None:
    """The ``.env.example`` placeholder must not silently boot."""
    _set_env(
        monkeypatch,
        WORKOS_API_KEY="sk_test_x",
        WORKOS_CLIENT_ID="__REPLACE_WITH_PROD_WORKOS_CLIENT_ID__",
        WORKOS_COOKIE_PASSWORD="x" * 44,
    )
    with pytest.raises(RuntimeError, match="is not a real client ID"):
        make_workos_client()


def test_garbage_client_id_refuses_boot(monkeypatch: pytest.MonkeyPatch) -> None:
    """Any value that doesn't start with ``client_`` is rejected — covers
    typos like a leading-space copy-paste."""
    _set_env(
        monkeypatch,
        WORKOS_API_KEY="sk_test_x",
        WORKOS_CLIENT_ID="01KQ7E6RGDW0HMDE7WY9MG366S",  # forgot the prefix
        WORKOS_COOKIE_PASSWORD="x" * 44,
    )
    with pytest.raises(RuntimeError, match="is not a real client ID"):
        make_workos_client()


def test_real_shaped_client_id_constructs(monkeypatch: pytest.MonkeyPatch) -> None:
    """A well-formed client_id constructs the real client without raising.

    We can't actually exercise WorkOS network calls in unit tests; just
    asserting the constructor doesn't raise covers the validation path.
    """
    _set_env(
        monkeypatch,
        WORKOS_API_KEY="sk_test_x",
        WORKOS_CLIENT_ID="client_01KQ7E6RGDW0HMDE7WY9MG366S",
        WORKOS_COOKIE_PASSWORD="x" * 44,
    )
    client = make_workos_client()
    assert client is not None


def test_missing_cookie_password_refuses_boot(monkeypatch: pytest.MonkeyPatch) -> None:
    """Already-existing guard: with a real WORKOS_API_KEY but no
    cookie password, sessions can't be sealed and we won't boot."""
    _set_env(
        monkeypatch,
        WORKOS_API_KEY="sk_test_x",
        WORKOS_CLIENT_ID="client_01KQ7E6RGDW0HMDE7WY9MG366S",
        WORKOS_COOKIE_PASSWORD=None,
    )
    with pytest.raises(RuntimeError, match="WORKOS_COOKIE_PASSWORD is missing"):
        make_workos_client()
