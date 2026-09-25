"""extensions/hermes/reinstall.sh driven against a fake ``hermes`` on PATH."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")

SCRIPT = Path(__file__).resolve().parents[2] / "extensions" / "hermes" / "reinstall.sh"
IDENTITY = "OPENROUTER_API_KEY=or-1\nCLAWBITS_API_KEY=key-1\nCLAWBITS_AGENT_ID=agent-1\n"
STATE = "plugin-data/clawbits-platform"

# Logs "<profile>|<args>" to $FAKE_LOG. FAKE_HEALTHY lists the versions doctor calls
# ready; FAKE_DOCTOR_RC overrides doctor's exit code; FAKE_RESTART_RC[_<profile>] and
# FAKE_STOP_RC are the restart/stop exit codes; FAKE_RESTART_SLEEP keeps a restart
# running; FAKE_MUX_SERVES lists profiles a default restart reloads; FAKE_SIGNUP_RC
# makes signup fail.
FAKE_HERMES = r"""#!/usr/bin/env bash
prof=default
if [[ "${1:-}" == -p ]]; then prof=$2; shift 2; fi
root="${HERMES_HOME:-$HOME/.hermes}"
home="$root"; [[ $prof == default ]] || home="$root/profiles/$prof"
echo "$prof|$*" >> "$FAKE_LOG"
installed="$home/plugins/clawbits-platform"
ver() { sed -n 's/^version: *//p' "$1/plugin.yaml" 2>/dev/null; }
case "$*" in
  --version) echo "Hermes Agent v0.21.3 (2026.9.14)" ;;
  "clawbits doctor --preflight") [[ -f "$installed/plugin.yaml" ]] || exit 2
      if grep -q BROKEN "$installed/plugin.yaml"; then
        mkdir -p "$home/logs"; echo "Failed to load plugin 'clawbits-platform'" > "$home/logs/errors.log"; exit 2
      fi ;;
  "clawbits doctor --wait"*) [[ -z "${FAKE_DOCTOR_RC:-}" ]] || exit "$FAKE_DOCTOR_RC"
      [[ " ${FAKE_HEALTHY:-} " == *" $(cat "$home/running.version") "* ]] || exit 3 ;;
  "plugins enable clawbits-platform") ;;
  "clawbits signup"*) [[ -z "${FAKE_SIGNUP_RC:-}" ]] || exit "$FAKE_SIGNUP_RC"
      grep -q '^CLAWBITS_API_KEY=' "$home/.env" 2>/dev/null \
      || printf 'CLAWBITS_API_KEY=new-key\nCLAWBITS_AGENT_ID=new-agent\n' >> "$home/.env" ;;
  "gateway restart")
    rc_var="FAKE_RESTART_RC_$prof"; rc="${!rc_var:-${FAKE_RESTART_RC:-0}}"
    [[ $rc -eq 0 ]] || exit "$rc"
    [[ -n "${INVOCATION_ID:-}" ]] && echo "INVOCATION_ID leaked" >> "$FAKE_LOG"
    ver "$installed" > "$home/running.version"
    for served in ${FAKE_MUX_SERVES:-}; do
      [[ $prof == default ]] && ver "$root/profiles/$served/plugins/clawbits-platform" > "$root/profiles/$served/running.version"
    done
    sleep "${FAKE_RESTART_SLEEP:-0}" ;;
  "gateway stop") exit "${FAKE_STOP_RC:-0}" ;;
  *) echo "fake hermes: unexpected: $*" >&2; exit 64 ;;
esac
"""


def _plugin(path: Path, version: str, *, doctor: bool = True, broken: bool = False) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / "plugin.yaml").write_text(f"name: clawbits-platform\nversion: {version}\n" + ("BROKEN\n" if broken else ""))
    (path / "__init__.py").write_text("")
    if doctor:
        (path / "doctor.py").write_text("")
    return path


@pytest.fixture
def env(tmp_path):
    src = _plugin(tmp_path / "src", "0.10.0")
    (src / "__pycache__").mkdir()
    shutil.copy(SCRIPT, src / "reinstall.sh")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "hermes").write_text(FAKE_HERMES)
    (bindir / "hermes").chmod(0o755)
    root = tmp_path / "hermes"
    (root / "profiles" / "b").mkdir(parents=True)
    log = tmp_path / "calls.log"
    log.touch()
    base = {**os.environ, "HERMES_HOME": str(root), "PATH": f"{bindir}:{os.environ['PATH']}",
            "FAKE_LOG": str(log), "CLAWBITS_UPGRADE_WAIT": "1", "CLAWBITS_RESTART_SETTLE": "1",
            "FAKE_HEALTHY": "0.9.0 0.10.0"}
    base.pop("INVOCATION_ID", None)

    def run(*args: str, stdin: str = "", script: Path = src / "reinstall.sh",
            **extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["bash", str(script), *args], env={**base, **extra},
                              input=stdin, text=True, capture_output=True, timeout=60)

    return SimpleNamespace(src=src, root=root, log=log, run=run, calls=lambda: log.read_text().splitlines())


def _installed(home: Path) -> str:
    return (home / "plugins/clawbits-platform/plugin.yaml").read_text().split("version: ")[1].split()[0]


def _setup_existing(home: Path, version: str = "0.9.0") -> None:
    _plugin(home / "plugins/clawbits-platform", version, doctor=False)
    (home / ".env").write_text(IDENTITY)
    (home / STATE).mkdir(parents=True)
    (home / STATE / "inbox.db").write_text("journal")
    (home / "clawbits-read-cursors.json").write_text('{"c": 7}')


def _snapshot(path: Path) -> dict[Path, bytes]:
    return {p: p.read_bytes() for p in path.rglob("*") if p.is_file()}


def test_upgrade_preserves_identity_state_and_other_profile(env):
    _setup_existing(env.root)
    b = env.root / "profiles/b"
    _setup_existing(b)
    before_b = _snapshot(b)
    r = env.run()
    assert r.returncode == 0, r.stdout + r.stderr
    assert _installed(env.root) == "0.10.0"
    assert (env.root / ".env").read_text() == IDENTITY
    assert (env.root / STATE / "inbox.db").read_text() == "journal"
    assert (env.root / "clawbits-read-cursors.json").read_text() == '{"c": 7}'
    assert [p.name for p in (env.root / "plugins").iterdir()] == ["clawbits-platform"]
    assert not (env.root / "plugins/clawbits-platform/__pycache__").exists()
    assert (env.root / "clawbits-upgrade/prev/plugin.yaml").read_text().endswith("0.9.0\n")
    assert not (env.root / "clawbits-upgrade/lock").exists()
    assert _snapshot(b) == before_b
    calls = env.calls()
    assert "default|gateway restart" in calls and not any(c.startswith("b|") for c in calls)
    assert not any("plugins enable" in c for c in calls), "an upgrade leaves config alone"


def test_invalid_package_changes_nothing(env):
    _setup_existing(env.root)
    _plugin(env.src, "0.10.0", broken=True)
    r = env.run()
    assert r.returncode == 1 and "nothing was changed" in r.stderr
    assert "Failed to load plugin 'clawbits-platform'" in r.stderr, "the loader's error is shown"
    assert _installed(env.root) == "0.9.0"
    assert "default|gateway restart" not in env.calls()


def test_reset_with_invalid_package_changes_nothing(env):
    _setup_existing(env.root)
    _plugin(env.src, "0.10.0", broken=True)
    before = _snapshot(env.root)
    r = env.run("--reset", "-y")
    assert r.returncode == 1 and "nothing was changed" in r.stderr
    assert {p: v for p, v in _snapshot(env.root).items() if "clawbits-upgrade" not in p.parts} == before
    assert "default|gateway stop" not in env.calls()


def test_failed_health_rolls_back(env):
    _setup_existing(env.root)
    r = env.run(FAKE_HEALTHY="0.9.0")
    assert r.returncode == 1 and "rolling back" in r.stderr
    assert _installed(env.root) == "0.9.0"
    assert env.calls().count("default|gateway restart") == 2
    assert (env.root / ".env").read_text() == IDENTITY


def test_unusable_doctor_rolls_back(env):
    """The new copy ships doctor.py, so a doctor the profile's Hermes cannot run fails the gate."""
    _setup_existing(env.root)
    r = env.run(FAKE_DOCTOR_RC="2")
    assert r.returncode == 1 and "rolling back" in r.stderr
    assert _installed(env.root) == "0.9.0"
    assert "previous plugin restored" in r.stderr, "0.9.0 has no doctor, so its restart is not gated"


def test_multiplexer_refusal_restores_previous(env):
    b = env.root / "profiles/b"
    _setup_existing(b)
    r = env.run("--profile", "b", FAKE_RESTART_RC_b="78")
    assert r.returncode == 3 and "--restart-default" in r.stderr and "previous plugin is restored" in r.stderr
    assert _installed(b) == "0.9.0"
    assert "default|gateway restart" not in env.calls()


def test_multiplexer_refusal_after_enrollment_says_to_drop_the_token(env):
    r = env.run("--profile", "b", "--signup-token", "tok", FAKE_RESTART_RC_b="78")
    assert r.returncode == 3 and "omit --signup-token" in r.stderr
    assert _installed(env.root / "profiles/b") == "0.10.0"


def test_restart_default_applies_a_served_profile(env):
    b = env.root / "profiles/b"
    _setup_existing(b)
    r = env.run("--profile", "b", "--restart-default", FAKE_RESTART_RC_b="78", FAKE_MUX_SERVES="b")
    assert r.returncode == 0, r.stdout + r.stderr
    assert _installed(b) == "0.10.0"
    calls = env.calls()
    assert calls.count("b|gateway restart") == 1 and calls.count("default|gateway restart") == 1


def test_rollback_swaps_and_is_reversible(env):
    _setup_existing(env.root)
    assert env.run().returncode == 0
    r = env.run("--rollback")
    assert r.returncode == 0, r.stderr
    assert _installed(env.root) == "0.9.0" and "predates the intake journal" in r.stdout
    assert env.run("--rollback").returncode == 0 and _installed(env.root) == "0.10.0"
    assert (env.root / STATE / "inbox.db").read_text() == "journal", "rollback never touches state"


def test_rollback_without_previous_copy_fails(env):
    _plugin(env.root / "plugins/clawbits-platform", "0.10.0")
    r = env.run("--rollback")
    assert r.returncode == 1 and "no previous plugin" in r.stderr
    assert _installed(env.root) == "0.10.0"


def test_reset_is_explicit_and_profile_scoped(env):
    _setup_existing(env.root)
    (env.root / ".clawbits_greeted").write_text("")
    b = env.root / "profiles/b"
    _setup_existing(b)
    r = env.run("--reset", "-y", "--signup-token", "tok")
    assert r.returncode == 0, r.stdout + r.stderr
    envtext = (env.root / ".env").read_text()
    assert "key-1" not in envtext and "CLAWBITS_AGENT_ID=new-agent" in envtext and "OPENROUTER_API_KEY=or-1" in envtext
    saved = next((env.root / "clawbits-upgrade").glob("reset-*"))
    assert (saved / STATE / "inbox.db").read_text() == "journal"
    assert (saved / "plugins/clawbits-platform/plugin.yaml").exists()
    assert (saved / "clawbits-read-cursors.json").exists() and (saved / ".clawbits_greeted").exists()
    assert not (env.root / STATE).exists() and _installed(env.root) == "0.10.0"
    assert "key-1" not in "".join(p.read_text() for p in saved.rglob("*") if p.is_file())
    calls = env.calls()
    assert "default|gateway stop" in calls and not any(c.startswith("b|") for c in calls)
    assert (b / ".env").read_text() == IDENTITY


@pytest.mark.parametrize(("stop_rc", "rc", "message"), [("78", 3, "served by the default gateway"),
                                                         ("1", 1, "could not stop")])
def test_reset_changes_nothing_when_the_gateway_does_not_stop(env, stop_rc, rc, message):
    _setup_existing(env.root)
    before = _snapshot(env.root)
    r = env.run("--reset", "-y", "--signup-token", "tok", FAKE_STOP_RC=stop_rc)
    assert r.returncode == rc and message in r.stderr and "nothing was changed" in r.stderr
    assert {p: v for p, v in _snapshot(env.root).items() if "clawbits-upgrade" not in p.parts} == before
    assert not list((env.root / "clawbits-upgrade").glob("reset-*"))
    assert not any("signup" in c or "restart" in c for c in env.calls())


def test_reset_without_yes_aborts_on_no(env):
    _setup_existing(env.root)
    before = _snapshot(env.root)
    for stdin in ("n\n", ""):
        r = env.run("--reset", stdin=stdin)
        assert r.returncode == 1 and "aborted." in r.stdout
    assert {p: v for p, v in _snapshot(env.root).items() if "clawbits-upgrade" not in p.parts} == before
    assert env.calls() == []


def test_signup_token_with_existing_identity_is_reported(env):
    _setup_existing(env.root)
    r = env.run("--signup-token", "tok")
    assert r.returncode == 4 and "NOT used" in r.stderr
    assert (env.root / ".env").read_text() == IDENTITY
    assert _installed(env.root) == "0.10.0"


def test_unused_token_is_reported_before_a_multiplexer_refusal(env):
    b = env.root / "profiles/b"
    _setup_existing(b)
    r = env.run("--profile", "b", "--signup-token", "tok", FAKE_RESTART_RC_b="78")
    assert r.returncode == 4 and "NOT used" in r.stderr and "--restart-default" in r.stderr
    assert _installed(b) == "0.9.0" and (b / ".env").read_text() == IDENTITY
    assert "default|gateway restart" not in env.calls()


def test_unused_token_with_a_failed_upgrade_exits_1(env):
    _setup_existing(env.root)
    r = env.run("--signup-token", "tok", FAKE_HEALTHY="0.9.0")
    assert r.returncode == 1 and "NOT used" in r.stderr and "rolling back" in r.stderr
    assert _installed(env.root) == "0.9.0"


def test_fresh_install_enables_and_waits_for_signup(env):
    r = env.run()
    assert r.returncode == 0, r.stderr
    calls = env.calls()
    assert "default|plugins enable clawbits-platform" in calls
    assert "default|gateway restart" not in calls and "clawbits signup" in r.stdout


def test_failed_signup_is_reported_without_restart(env):
    r = env.run("--signup-token", "tok", FAKE_SIGNUP_RC="1")
    assert r.returncode == 1 and "signup failed" in r.stderr
    assert _installed(env.root) == "0.10.0"
    assert "default|gateway restart" not in env.calls()


def test_fresh_install_into_a_missing_default_home(env, tmp_path):
    root = tmp_path / "new-home"
    r = env.run(HERMES_HOME=str(root))
    assert r.returncode == 0, r.stderr
    assert _installed(root) == "0.10.0"


def test_fresh_install_with_token_signs_up_and_restarts(env):
    r = env.run("--signup-token", "tok", "--endpoint", "http://x:8000")
    assert r.returncode == 0, r.stdout + r.stderr
    calls = env.calls()
    assert "default|clawbits signup --signup-token tok --endpoint http://x:8000" in calls
    assert "default|gateway restart" in calls


def test_sticky_active_profile_is_honoured(env):
    b = env.root / "profiles/b"
    _setup_existing(b)
    (env.root / "active_profile").write_text("b\n")
    assert env.run().returncode == 0
    assert _installed(b) == "0.10.0" and not (env.root / "plugins").exists()


def test_profile_home_in_hermes_home_is_honoured(env):
    b = env.root / "profiles/b"
    _setup_existing(b)
    r = env.run(HERMES_HOME=str(b))
    assert r.returncode == 0, r.stderr
    assert _installed(b) == "0.10.0" and "b|gateway restart" in env.calls()


def test_missing_profile_is_an_error(env):
    r = env.run("--profile", "nope")
    assert r.returncode == 1 and "not found" in r.stderr


def test_usage_errors_exit_2(env):
    assert env.run("--bogus").returncode == 2
    assert env.run("--profile").returncode == 2
    (env.root / "active_profile").write_text("../b\n")
    assert env.run().returncode == 2
    assert env.run("--profile", "..").returncode == 2
    assert env.calls() == [] and not (env.root / "clawbits-upgrade").exists()


def test_a_bundled_image_install_refuses_to_stage(env, tmp_path):
    """The image bakes the plugin under plugins/platforms/; a staged copy would live on the
    data volume and shadow it at every later start."""
    baked = _plugin(tmp_path / "opt/hermes/plugins/platforms/clawbits", "0.10.0")
    shutil.copy(SCRIPT, baked / "reinstall.sh")
    _setup_existing(env.root)

    r = env.run(script=baked / "reinstall.sh")
    assert r.returncode == 2 and "bundled image install" in r.stderr
    assert "clawbits doctor" in r.stderr and "clawbits inbox" in r.stderr
    assert env.calls() == [] and not (env.root / "clawbits-upgrade").exists()
    assert _installed(env.root) == "0.9.0", "nothing staged, nothing switched"


def test_interrupted_switch_is_recovered(env):
    _setup_existing(env.root)
    work = env.root / "clawbits-upgrade"
    work.mkdir()
    shutil.move(env.root / "plugins/clawbits-platform", work / "prev")
    r = env.run("--no-restart")
    assert r.returncode == 0 and "interrupted switch" in r.stdout
    assert _installed(env.root) == "0.10.0" and (work / "prev/plugin.yaml").exists()
    assert "default|gateway restart" not in env.calls()


def test_concurrent_run_is_refused(env):
    _setup_existing(env.root)
    (env.root / "clawbits-upgrade/lock").mkdir(parents=True)
    r = env.run()
    assert r.returncode == 1 and "another upgrade" in r.stderr
    assert _installed(env.root) == "0.9.0" and (env.root / "clawbits-upgrade/lock").is_dir()


def test_restart_that_keeps_running_counts_as_started(env):
    _setup_existing(env.root)
    r = env.run(FAKE_RESTART_SLEEP="4")
    assert r.returncode == 0, r.stderr
    assert _installed(env.root) == "0.10.0"


def test_restart_drops_invocation_id(env):
    _setup_existing(env.root)
    assert env.run(INVOCATION_ID="abc").returncode == 0
    assert "INVOCATION_ID leaked" not in env.log.read_text()


def test_help_is_the_header(env):
    r = env.run("--help")
    assert r.returncode == 0 and "--reset" in r.stdout and "Exit:" in r.stdout and "set -euo" not in r.stdout
