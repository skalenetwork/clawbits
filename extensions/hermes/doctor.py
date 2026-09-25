"""``hermes clawbits doctor``: a redacted health report for this profile's plugin.

Exit codes: 0 healthy, 1 degraded (still receiving), 3 not ready (the receive path is
down or held, or the running gateway predates this install). ``--wait`` polls the
local checks until ready, ``--since`` requires a gateway started after that time and
``--preflight`` runs only the offline checks for a staged copy.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .cli_client import _ClawbitsCli, _default_cli_path, endpoint, http_status
from .health import error_code, profile_home, read_status, suspension_opted_in
from .manifest import PLUGIN_VERSION

OK, WARN, FAIL, DOWN = "ok", "warn", "fail", "down"
_EXIT = {OK: 0, WARN: 0, FAIL: 1, DOWN: 3}
_DEGRADING = {"chat", "email", "reader", "outbox"}  # an error here is a failure, elsewhere a warning
_FINAL_ITEMS = {"processed", "ignored", "deleted"}
_IDLE_STATES = {"disabled", "not_configured"}  # a subsystem switched off is never stalled
_HEARTBEAT_STALE_S = 120


@dataclass(frozen=True)
class Check:
    name: str
    level: str
    detail: str


def _age(ts: Any) -> str:
    return f"{int(time.time() - float(ts))}s ago" if isinstance(ts, (int, float)) else "never"


def _count(value: Any) -> int:
    return len(value) if isinstance(value, (list, tuple, dict)) else int(value or 0)


def _pid_alive(pid: Any) -> bool:
    try:
        os.kill(int(pid), 0)
    except PermissionError:
        return True
    except (OSError, TypeError, ValueError):
        return False
    return True


def preflight() -> list[Check]:
    """Offline: this code loads in this Hermes and the agent CLI runs under its Python."""
    try:
        proc = subprocess.run([sys.executable, _default_cli_path(), "--help"], capture_output=True, timeout=60)
        cli = Check("agent_cli", OK if proc.returncode == 0 else DOWN, f"--help exited {proc.returncode}")
    except (OSError, subprocess.TimeoutExpired) as exc:
        cli = Check("agent_cli", DOWN, f"--help failed ({error_code(exc)})")
    return [Check("plugin", OK, f"{PLUGIN_VERSION} loads in this Hermes"), cli]


def _subsystem(name: str, entry: dict[str, Any], started_at: float) -> Check:
    error, last_ok = entry.get("error"), entry.get("last_ok_at")
    facts = ", ".join(f"{k} {entry[k]}" for k in ("state", "epoch", "incremental") if k in entry)
    seen = f"ok {_age(last_ok)}, receipt {_age(entry.get('last_receipt_at'))}" + (f", {facts}" if facts else "")
    level = FAIL if name in _DEGRADING else WARN
    if name == "chat" and not (isinstance(last_ok, (int, float)) and last_ok >= started_at):
        return Check(name, DOWN, f"no successful poll since start ({error or 'pending'})")
    if error:
        return Check(name, level, f"{error} x{entry.get('failures', 1)}; {seen}")
    interval = 0.0 if entry.get("state") in _IDLE_STATES else float(entry.get("interval_s") or 0)
    if interval and isinstance(last_ok, (int, float)) and time.time() - last_ok > 3 * interval + 60:
        return Check(name, level, f"stalled; {seen}")
    return Check(name, OK, seen)


def plugin_checks(home: Path, since: float | None) -> list[Check]:
    """The running plugin's status file: version, restart, hold, per-subsystem health."""
    status = read_status(home)
    if status is None:
        return [Check("plugin", DOWN, "no status from a running plugin")]
    version, started = status.get("plugin_version"), float(status.get("started_at") or 0)
    if version != PLUGIN_VERSION:
        return [Check("plugin", DOWN, f"gateway runs {version}, installed {PLUGIN_VERSION}: restart pending")]
    if since is not None and started < since:
        return [Check("plugin", DOWN, "not restarted since the install")]
    if status.get("stopped_at") or not _pid_alive(status.get("pid")):
        return [Check("plugin", DOWN, "the plugin's gateway process is not running")]
    if status.get("hold"):
        return [Check("plugin", DOWN, f"intake held: {status['hold']}")]
    subsystems = {"chat": {}, **(status.get("subsystems") or {})}
    return [Check("plugin", OK, f"{version}, started {_age(started)}")] + [
        _subsystem(name, entry, started) for name, entry in sorted(subsystems.items())]


def gateway_checks(home: Path) -> list[Check]:
    """Hermes liveness ladder, gateway_state, clawbits platform state and loop-heartbeat age."""
    try:
        from gateway.shutdown_watchdog import get_loop_heartbeat_path
        from gateway.status import read_runtime_status, resolve_gateway_liveness
        from hermes_constants import get_default_hermes_root, profile_name_for_home
    except ImportError as exc:
        return [Check("gateway", WARN, f"liveness API unavailable in this Hermes ({error_code(exc)})")]

    # Unscoped: this CLI runs with the profile's HERMES_HOME, and the scoped form does
    # not recognise a default-profile gateway outside ~/.hermes.
    live = resolve_gateway_liveness(use_cache=False)
    if not live.running:
        return [Check("gateway", DOWN, "not running")]
    served = live.source == "multiplexer"
    gw_home = Path(get_default_hermes_root()) if served else home
    runtime = (live.runtime if served else read_runtime_status(home / "gateway_state.json")) or {}
    key = f"{profile_name_for_home(home)}:clawbits" if served else "clawbits"
    platform = (runtime.get("platforms") or {}).get(key) or {}
    try:
        beat = json.loads(get_loop_heartbeat_path(gw_home).read_text(encoding="utf-8"))
        beat_age: float | None = time.time() - datetime.fromisoformat(beat["updated_at"]).timestamp()
    except (OSError, ValueError, KeyError, TypeError):
        beat_age = None
    state = runtime.get("gateway_state")
    detail = (f"pid {live.pid}{' (multiplexer)' if served else ''}, state {state}, clawbits "
              f"{platform.get('state', 'unknown')}, heartbeat {'none' if beat_age is None else f'{int(beat_age)}s'}")
    if runtime.get("exit_reason"):
        detail += f", exit_reason {runtime['exit_reason']}"
    if state == "starting":
        return [Check("gateway", DOWN, detail)]
    bad = (state not in (None, "running") or platform.get("state") in ("fatal", "retrying")
           or beat_age is None or beat_age > _HEARTBEAT_STALE_S)
    return [Check("gateway", FAIL if bad else OK, detail)]


def queue_checks(home: Path) -> list[Check]:
    """Journal counts via inbox_state.read_stats (queue depth, oldest age, stalled, needs_review, outbox)."""
    try:
        from .inbox_state import read_stats
    except ImportError:
        return []
    try:
        stats = read_stats(home)
    except Exception as exc:
        return [Check("queue", FAIL, f"journal unreadable ({error_code(exc)})")]
    if not stats:
        return []
    if not stats.get("supported", True):
        return [Check("queue", DOWN, f"journal schema {stats.get('schema')} needs a newer plugin "
                                     f"(min_reader {stats.get('min_reader')})")]
    items = stats.get("items") or {}
    review, sources = _count(items.get("needs_review")), _count(stats.get("sources_needing_review"))
    parts = [f"{state} {n}" for state, n in sorted(items.items()) if n and state not in _FINAL_ITEMS] or ["empty"]
    if stats.get("oldest_open_age_s") is not None:
        parts.append(f"oldest open {int(stats['oldest_open_age_s'])}s")
    if stats.get("stalled"):
        parts.append("stalled")
    if sources:
        parts.append(f"{sources} source(s) need migration review")
    checks = [Check("queue", FAIL if review or sources or stats.get("stalled") else OK, ", ".join(parts))]
    replies = {s: n for s, n in (stats.get("replies") or {}).items() if s in ("unknown", "failed") and n}
    if replies:
        checks.append(Check("outbox", FAIL, ", ".join(f"{s} {n}" for s, n in sorted(replies.items()))))
    return checks


def local_checks(home: Path, since: float | None = None) -> list[Check]:
    """All file-based checks (cheap enough to poll)."""
    checks = gateway_checks(home) + plugin_checks(home, since) + queue_checks(home)
    spool = list((home / "pending_messages").glob("pending-*.json"))
    if spool:
        checks.append(Check("transcripts", WARN, f"{len(spool)} spooled Hermes message(s) awaiting replay"))
    if suspension_opted_in():
        checks.append(Check("suspension", WARN, "idle suspension opted in; Clawbits polling has no wake path"))
    return checks


def _identity() -> tuple[str, str, _ClawbitsCli] | None:
    """(agent_id, endpoint, client) for this profile's identity; None when it has none."""
    try:
        from .account import resolve_account
    except ImportError:
        api_key, agent_id, base_url = os.getenv("CLAWBITS_API_KEY"), os.getenv("CLAWBITS_AGENT_ID"), endpoint()
        return (agent_id, base_url, _ClawbitsCli(_default_cli_path(), base_url, api_key)) if api_key and agent_id else None
    account = resolve_account()
    return (account.agent_id, account.base_url, _ClawbitsCli.for_account(account)) if account.usable else None


def live_checks() -> list[Check]:
    """Identity presence/acceptance, backend reachability, operator binding (one agent-info call)."""
    try:
        identity = _identity()
    except Exception as exc:
        return [Check("identity", DOWN, f"unresolvable ({error_code(exc)})")]
    if identity is None:
        return [Check("identity", DOWN, "no Clawbits API key and agent id in this profile")]
    agent_id, base_url, client = identity
    try:
        info = client.agent_info(agent_id)
    except Exception as exc:
        status = http_status(exc)
        if status in (401, 403):
            return [Check("identity", DOWN, f"agent {agent_id} rejected (HTTP {status})")]
        return [Check("backend", FAIL, f"{base_url} unreachable ({error_code(exc)})")]
    operator = info.get("operator_id")
    return [Check("identity", OK, f"agent {agent_id} accepted by {base_url}"),
            Check("operator", OK if operator else WARN,
                  f"operator {operator} bound" if operator else "no operator binding; gateway controls denied")]


def _redacted(text: str) -> str:
    try:
        from agent.redact import redact_sensitive_text

        return redact_sensitive_text(text, force=True, redact_url_credentials=True)
    except Exception:
        return "[redacted]"


def run(args: argparse.Namespace) -> int:
    """Print the redacted report; return the worst check's exit code."""
    if args.preflight:
        checks = preflight()
    else:
        home = profile_home()
        deadline = time.time() + float(args.wait or 0)
        while True:
            checks = local_checks(home, args.since)
            if all(c.level != DOWN for c in checks) or time.time() >= deadline:
                break
            time.sleep(2)
        checks += live_checks()
    checks = [Check(c.name, c.level, _redacted(c.detail)) for c in checks]
    if args.json:
        print(json.dumps([asdict(c) for c in checks]))
    else:
        for c in checks:
            print(f"  [{c.level:4}] {c.name:12} {c.detail}")
    return max(_EXIT[c.level] for c in checks)
