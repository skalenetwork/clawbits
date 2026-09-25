"""reinstall.sh against real `hermes gateway run` processes, doctor's preflight, and the idle-suspension gate."""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from conftest import LAYOUT, PLUGIN_SRC
from fake_clawbits import MODEL, OPERATOR_DM, FakeClawbits

HERMES = Path(sys.executable).with_name("hermes")
PLUGIN = "clawbits-platform"
OLD = re.search(r"^version:\s*(\S+)", (PLUGIN_SRC / "plugin.yaml").read_text(), re.M).group(1)
NEW = "0.99.0"
self_hosted = pytest.mark.skipif(LAYOUT != "user", reason="self-hosted install; the image is replaced whole")


def _copy(dest: Path, version: str = OLD) -> Path:
    shutil.copytree(PLUGIN_SRC, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    manifest = dest / "plugin.yaml"
    manifest.write_text(re.sub(r"^version:.*$", f"version: {version}", manifest.read_text(), flags=re.M))
    return dest


def _wait(predicate: Callable[[], Any], timeout: float, what: str) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError(f"{what} within {timeout}s")
        time.sleep(0.25)


class Host:
    """A self-hosted HERMES_HOME with the old plugin installed, served by real gateway processes."""

    def __init__(self, tmp_path: Path) -> None:
        self.fake = FakeClawbits()
        self.root = tmp_path / "root"
        self.src = tmp_path / "src"
        self.groups: list[int] = []  # process groups to reap: gateways and the script's detached restart
        _copy(self.root / "plugins" / PLUGIN)
        (self.root / "config.yaml").write_text(json.dumps({
            "model": {"default": MODEL, "provider": "custom", "base_url": f"{self.fake.base_url}/v1",
                      "api_key": "stub", "context_length": 65536},
            "auxiliary": {"title_generation": {"enabled": False}},
            "plugins": {"enabled": [PLUGIN]},
        }))
        self.identity = (f"CLAWBITS_API_KEY=cb-test-key\nCLAWBITS_AGENT_ID={self.fake.agent_id}\n"
                         f"CLAWBITS_ENDPOINT={self.fake.base_url}\nCLAWBITS_CHANNEL_ID={OPERATOR_DM}\n"
                         "CLAWBITS_POLL_INTERVAL=0.2\nCLAWBITS_EMAIL_ENABLED=false\n")
        (self.root / ".env").write_text(self.identity)
        self.env = {k: v for k, v in os.environ.items() if k != "INVOCATION_ID"}
        self.env.update(HERMES_HOME=str(self.root), PATH=f"{HERMES.parent}:{os.environ['PATH']}")

    def hermes(self, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([str(HERMES), *args], env={**self.env, **env}, text=True, capture_output=True,
                              timeout=180)

    def start(self) -> None:
        log = (self.root / "gateway-initial.log").open("w")
        proc = subprocess.Popen([str(HERMES), "gateway", "run"], env=self.env, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True)
        self.groups.append(proc.pid)
        self.ready()

    def ready(self) -> None:
        doctor = self.hermes("clawbits", "doctor", "--wait", "90")
        assert doctor.returncode == 0, doctor.stdout + doctor.stderr

    def reinstall(self, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
        proc = subprocess.Popen(["bash", str(self.src / "reinstall.sh"), *args], env={**self.env, **env}, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        self.groups.append(proc.pid)
        out, err = proc.communicate(timeout=400)
        return subprocess.CompletedProcess(proc.args, proc.returncode, out, err)

    def installed(self) -> str:
        return re.search(r"^version:\s*(\S+)", (self.root / "plugins" / PLUGIN / "plugin.yaml").read_text(), re.M)[1]

    def status(self) -> dict[str, Any]:
        return json.loads((self.root / "plugin-data" / PLUGIN / "status.json").read_text())

    def answers(self, text: str) -> None:
        """A new operator message gets the scripted reply: the receive path works end to end."""
        self.fake.script(text)
        self.fake.post("are you there?")
        _wait(lambda: any(p["message"] == text and p["agent_id"] for p in self.fake.posts), 60, "no reply")

    def close(self) -> None:
        self.hermes("gateway", "stop")
        for group in self.groups:
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.fake.close()


@pytest.fixture
def host(tmp_path):
    host = Host(tmp_path)
    yield host
    host.close()


@self_hosted
def test_upgrade_real_gateway(host):
    host.start()
    _copy(host.src, NEW)
    r = host.reinstall(CLAWBITS_UPGRADE_WAIT="90")
    assert r.returncode == 0, r.stdout + r.stderr
    assert host.installed() == NEW and host.status()["plugin_version"] == NEW
    assert (host.root / ".env").read_text() == host.identity
    assert [p.name for p in (host.root / "plugins").iterdir()] == [PLUGIN]
    assert host.hermes("clawbits", "doctor").returncode == 0
    host.answers("hello after the upgrade")


# Appended to the new version's adapter.py: every intake pass fails as the server would.
BROKEN_POLL = """

async def _failing_poll(self, *args, **kwargs):
    raise RuntimeError("HTTP 500: boom secret-key-123")


ClawbitsAdapter._poll_once = _failing_poll
"""


@self_hosted
def test_runtime_broken_version_rolls_back(host):
    host.start()
    adapter = _copy(host.src, NEW) / "adapter.py"
    source = adapter.read_text()
    assert "    async def _poll_once(self" in source, "the failure replaces the real intake pass"
    adapter.write_text(source + BROKEN_POLL)
    r = host.reinstall(CLAWBITS_UPGRADE_WAIT="20")
    assert r.returncode == 1 and "rolling back" in r.stderr, r.stdout + r.stderr
    assert "http_500" in r.stdout and "secret-key-123" not in r.stdout, "doctor reports codes only"
    assert host.installed() == OLD and f"version: {NEW}" in (host.root / "clawbits-upgrade/prev/plugin.yaml").read_text()
    host.ready()
    assert host.status()["plugin_version"] == OLD
    host.answers("hello after the rollback")


@self_hosted
@pytest.mark.parametrize("breakage", [None, "requires_hermes", "import", "yaml"])
def test_preflight_rejects_what_the_loader_rejects(tmp_path, breakage):
    stage = tmp_path / "stage"
    plugin = _copy(stage / "plugins" / PLUGIN)
    (stage / "config.yaml").write_text(f"plugins:\n  enabled: [{PLUGIN}]\n")
    manifest, init = plugin / "plugin.yaml", plugin / "__init__.py"
    if breakage == "requires_hermes":
        manifest.write_text(re.sub(r"^requires_hermes:.*$", 'requires_hermes: ">=9.0"', manifest.read_text(), flags=re.M))
    elif breakage == "import":
        init.write_text("import clawbits_missing_dependency\n" + init.read_text())
    elif breakage == "yaml":
        manifest.write_text(manifest.read_text() + "provides: [unclosed\n")
    env = {**os.environ, "HERMES_HOME": str(stage)}
    r = subprocess.run([str(HERMES), "-p", "default", "clawbits", "doctor", "--preflight"], env=env,
                       text=True, capture_output=True, timeout=180)
    assert r.returncode == (0 if breakage is None else 2), r.stdout + r.stderr


# Served-profile-only Clawbits: the adapter's warning and doctor's are the only guard at min.
SERVED_ONLY_ARMS = {"min": True, "current": False}


def test_idle_suspension_gate(gateway, monkeypatch):
    label = os.getenv("HERMES_RUNTIME_LABEL", "unpinned")
    if label not in SERVED_ONLY_ARMS:
        pytest.skip(f"no recorded expectation for Hermes {label}")
    import yaml
    from gateway.config import Platform, load_gateway_config
    from gateway.run import GatewayRunner
    from hermes_cli.plugins import discover_plugins

    (gateway.home / "config.yaml").write_text(yaml.safe_dump(gateway.config))
    discover_plugins(force=True)
    clawbits = Platform("clawbits")

    def arms(opted_in: bool, served_only: bool) -> bool:
        for name in ("HERMES_SCALE_TO_ZERO", "GATEWAY_RELAY_WAKE_URL"):
            monkeypatch.delenv(name, raising=False)
        if opted_in:
            monkeypatch.setenv("HERMES_SCALE_TO_ZERO", "1")
            monkeypatch.setenv("GATEWAY_RELAY_WAKE_URL", "https://wake.example/x")
        config = load_gateway_config()
        assert clawbits in config.platforms
        runner = GatewayRunner(config)
        if served_only:
            config.platforms.pop(clawbits)
            runner.adapters, runner._profile_adapters = {}, {"b": {clawbits: object()}}
        return runner._scale_to_zero_should_arm()

    assert arms(opted_in=True, served_only=False) is False, "a primary Clawbits keeps the gateway awake"
    assert arms(opted_in=True, served_only=True) is SERVED_ONLY_ARMS[label]
    assert arms(opted_in=False, served_only=True) is False
