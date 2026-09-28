"""Fixtures for the email unit tests (no database, no Stalwart)."""
from __future__ import annotations

from contextlib import contextmanager

import pytest

from clawbits.email import imap_client
from tests.email._fake_imap import FakeImap


@pytest.fixture
def patch_imap(monkeypatch):
    """Route ``imap_client._imap_connection`` to the given FakeImap."""

    def install(fake: FakeImap) -> FakeImap:
        @contextmanager
        def connection(agent_id):
            yield fake

        monkeypatch.setattr(imap_client, "_imap_connection", connection)
        return fake

    return install
