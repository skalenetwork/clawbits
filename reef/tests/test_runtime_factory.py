"""Runtime selection: explicit arg > REEF_RUNTIME env > per-platform default;
plus store selection via REEF_STORE / REEF_DB_PATH."""

import sys

import pytest

from reef.docker_runtime import DockerRuntime
from reef.microsandbox_runtime import MicrosandboxRuntime
from reef.runtime_factory import _default_db_path, default_backend, make_runtime, make_store
from reef.store import InMemorySandboxStore
from reef.store_sqlite import SqliteSandboxStore


def test_explicit_backend_wins():
    assert isinstance(make_runtime("docker"), DockerRuntime)
    assert isinstance(make_runtime("microsandbox"), MicrosandboxRuntime)
    assert isinstance(make_runtime("msb"), MicrosandboxRuntime)  # alias


def test_env_selects_backend(monkeypatch):
    monkeypatch.setenv("REEF_RUNTIME", "docker")
    assert isinstance(make_runtime(), DockerRuntime)
    monkeypatch.setenv("REEF_RUNTIME", "microsandbox")
    assert isinstance(make_runtime(), MicrosandboxRuntime)


def test_default_is_per_platform(monkeypatch):
    monkeypatch.delenv("REEF_RUNTIME", raising=False)
    assert default_backend() == ("docker" if sys.platform == "darwin" else "microsandbox")
    expected = DockerRuntime if sys.platform == "darwin" else MicrosandboxRuntime
    assert isinstance(make_runtime(), expected)


def test_unknown_backend_raises():
    with pytest.raises(ValueError, match="unknown REEF_RUNTIME"):
        make_runtime("podman")


def test_make_store_defaults_to_sqlite(monkeypatch, tmp_path):
    monkeypatch.delenv("REEF_STORE", raising=False)
    monkeypatch.setenv("REEF_DB_PATH", str(tmp_path / "reef.db"))
    assert isinstance(make_store(), SqliteSandboxStore)


def test_make_store_memory_selected_by_env(monkeypatch):
    monkeypatch.setenv("REEF_STORE", "memory")
    assert isinstance(make_store(), InMemorySandboxStore)


def test_make_store_unknown_raises(monkeypatch):
    monkeypatch.setenv("REEF_STORE", "redis")
    with pytest.raises(ValueError, match="unknown REEF_STORE"):
        make_store()


def test_db_path_prefers_explicit_then_state_dir(monkeypatch):
    monkeypatch.setenv("REEF_DB_PATH", "/tmp/explicit/reef.db")
    assert _default_db_path() == "/tmp/explicit/reef.db"
    monkeypatch.delenv("REEF_DB_PATH", raising=False)
    monkeypatch.setenv("REEF_STATE_DIR", "/var/lib/reef")
    assert _default_db_path() == "/var/lib/reef/reef.db"
