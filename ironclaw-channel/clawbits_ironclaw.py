#!/usr/bin/env python3
"""Clawbits IronClaw channel installer/configurator."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
CHANNEL_NAME = "clawbits"
DEFAULT_ENDPOINT = "https://app.clawbits.ai"


def ironclaw_home() -> Path:
    return Path(os.environ.get("IRONCLAW_HOME", str(Path.home() / ".ironclaw"))).expanduser()


def env_truthy(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        out[key.strip()] = value
    return out


def upsert_env(path: Path, key: str, value: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    new_lines: list[str] = []
    seen = False
    changed = False
    for line in lines:
        if line.startswith(f"{key}="):
            if not seen:
                replacement = f"{key}={value}"
                new_lines.append(replacement)
                changed = changed or line != replacement
                seen = True
            else:
                changed = True
            continue
        new_lines.append(line)
    if not seen:
        new_lines.append(f"{key}={value}")
        changed = True
        action = "+"
    else:
        action = "~" if changed else "="
    path.write_text("\n".join(new_lines).rstrip() + "\n", encoding="utf-8")
    return action


def ensure_env_list(path: Path, key: str, item: str) -> str:
    current = parse_env_file(path).get(key, "")
    items = [part.strip() for part in current.split(",") if part.strip()]
    if item in items:
        return "="
    items.append(item)
    return upsert_env(path, key, ",".join(items))


def mask(value: str) -> str:
    if not value:
        return "missing"
    if len(value) <= 8:
        return "***"
    return f"{value[:4]}…{value[-4:]}"


def run(cmd: list[str], *, cwd: Path = ROOT, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, text=True, check=check)


def build(force: bool, no_build: bool) -> None:
    wasm = ROOT / "clawbits.wasm"
    if no_build:
        if not wasm.exists():
            raise SystemExit("clawbits.wasm missing and --no-build set")
        return
    if force or not wasm.exists():
        print("Building clawbits.wasm…")
        run([str(ROOT / "build.sh")])


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def endpoint_from_manifest(path: Path) -> str:
    try:
        return str(load_json(path).get("config", {}).get("endpoint") or DEFAULT_ENDPOINT).rstrip("/")
    except Exception:
        return DEFAULT_ENDPOINT


def validate_endpoint(endpoint: str) -> tuple[str, str]:
    endpoint = endpoint.rstrip("/")
    parsed = urlparse(endpoint)
    if not parsed.scheme or not parsed.hostname:
        raise SystemExit(f"invalid endpoint: {endpoint!r}")
    return endpoint, parsed.hostname.lower()


def parse_allow_from(value: str | None) -> list[str] | None:
    if value is None:
        return None
    text = value.strip()
    if not text:
        return []
    if text.startswith("["):
        parsed = json.loads(text)
        if not isinstance(parsed, list) or not all(isinstance(x, str) for x in parsed):
            raise SystemExit("--allow-from JSON must be a string array")
        return parsed
    return [part.strip() for part in text.split(",") if part.strip()]


def patched_manifest(
    source: Path,
    installed: Path,
    *,
    endpoint: str | None,
    agent_id: str | None,
    clear_agent_id: bool,
    org_id: str | None,
    channel_id: str | None,
    clear_channel_id: bool,
    allow_from: list[str] | None,
    poll_interval_ms: int | None,
    preserve_existing: bool = True,
) -> dict:
    data = load_json(source)
    if preserve_existing and installed.exists():
        old = load_json(installed)
        data.setdefault("config", {}).update(old.get("config", {}))

    config = data.setdefault("config", {})
    endpoint = endpoint or str(config.get("endpoint") or DEFAULT_ENDPOINT)
    endpoint, host = validate_endpoint(endpoint)

    config["endpoint"] = endpoint
    if agent_id is not None:
        config["agent_id"] = agent_id or None
    elif clear_agent_id:
        config["agent_id"] = None
    if org_id is not None:
        config["org_id"] = org_id or None
    if channel_id is not None:
        config["channel_id"] = channel_id or None
    elif clear_channel_id:
        config["channel_id"] = None
    if allow_from is not None:
        config["allow_from"] = allow_from
    if poll_interval_ms is not None:
        config["poll_interval_ms"] = max(30000, poll_interval_ms)

    data.setdefault("setup", {})["setup_url"] = endpoint
    http = data.setdefault("capabilities", {}).setdefault("http", {})
    http["allowlist"] = [{"host": host, "path_prefix": "/api/agentic"}]
    for cred in http.setdefault("credentials", {}).values():
        if isinstance(cred, dict):
            cred["host_patterns"] = [host]
    return data


def install_artifacts(home: Path, args: argparse.Namespace) -> Path:
    channels_dir = home / "channels"
    channels_dir.mkdir(parents=True, exist_ok=True)
    wasm_dst = channels_dir / "clawbits.wasm"
    manifest_dst = channels_dir / "clawbits.capabilities.json"

    shutil.copy2(ROOT / "clawbits.wasm", wasm_dst)
    manifest = patched_manifest(
        ROOT / "clawbits.capabilities.json",
        manifest_dst,
        endpoint=args.endpoint or os.environ.get("CLAWBITS_ENDPOINT"),
        agent_id=args.agent_id,
        clear_agent_id=args.clear_agent_id or args.new_agent,
        org_id=args.org_id or os.environ.get("CLAWBITS_ORG_ID"),
        channel_id=args.channel_id,
        clear_channel_id=args.clear_channel_id,
        allow_from=parse_allow_from(args.allow_from),
        poll_interval_ms=args.poll_interval_ms,
        preserve_existing=not args.new_agent,
    )
    manifest_dst.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    shutil.copystat(ROOT / "clawbits.capabilities.json", manifest_dst)
    print(f"Installed channel into {channels_dir}")
    print(f"  ~ endpoint = {manifest['config']['endpoint']}")
    return manifest_dst


def update_config_toml(path: Path) -> None:
    try:
        import tomllib
    except ModuleNotFoundError:
        tomllib = None  # type: ignore[assignment]

    text = path.read_text(encoding="utf-8") if path.exists() else ""
    channels: list[str] = []
    if text.strip() and tomllib is not None:
        data = tomllib.loads(text)
        raw = data.get("channels", {}).get("wasm_channels", [])
        if isinstance(raw, list):
            channels = [str(item) for item in raw if str(item)]
    elif text.strip():
        match = re.search(r"(?ms)^\s*wasm_channels\s*=\s*\[(.*?)\]", text)
        if match:
            channels = [item for item in re.findall(r"[\"']([^\"']+)[\"']", match.group(1))]

    if CHANNEL_NAME not in channels:
        channels.append(CHANNEL_NAME)

    array = json.dumps(channels)
    lines = text.splitlines()
    header_re = re.compile(r"^\s*\[channels\]\s*(?:#.*)?$")
    table_re = re.compile(r"^\s*\[")
    start = next((i for i, line in enumerate(lines) if header_re.match(line)), None)

    if start is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.extend(["[channels]", "wasm_channels_enabled = true", f"wasm_channels = {array}"])
    else:
        end = len(lines)
        for i in range(start + 1, len(lines)):
            if table_re.match(lines[i]):
                end = i
                break
        managed_key_re = re.compile(r"^\s*(wasm_channels|wasm_channels_enabled)\s*=")
        block = [line for line in lines[start + 1 : end] if not managed_key_re.match(line)]
        managed = ["wasm_channels_enabled = true", f"wasm_channels = {array}"]
        lines = lines[: start + 1] + managed + block + lines[end:]

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    print("  ~ config.toml channels.wasm_channels += clawbits")


def resolve_libsql_path(home: Path) -> Path:
    """Locate IronClaw's libSQL/SQLite database.

    Honours ``LIBSQL_PATH`` from ``~/.ironclaw/.env`` (both this installer and
    IronClaw read it), otherwise the default ``<home>/ironclaw.db``.
    """
    raw = parse_env_file(home / ".env").get("LIBSQL_PATH", "").strip()
    return Path(raw).expanduser() if raw else home / "ironclaw.db"


def _read_setting_json(con: sqlite3.Connection, user_id: str, key: str):
    row = con.execute(
        "SELECT value FROM settings WHERE user_id = ? AND key = ?", (user_id, key)
    ).fetchone()
    if not row or row[0] is None:
        return None
    try:
        return json.loads(row[0])
    except (json.JSONDecodeError, TypeError):
        return None


def activate_in_db(home: Path) -> None:
    """Add ``clawbits`` to IronClaw's runtime-authoritative activation set.

    IronClaw decides which WASM channels to start at boot from the DB setting
    ``activated_channels`` (authoritative once present), falling back to the DB
    setting ``channels.wasm_channels`` — NOT from this installer's
    ``config.toml``/``.env``. Writing config.toml alone therefore leaves the
    channel installed-but-inactive on any host whose DB is already initialised.
    We merge ``clawbits`` into ``activated_channels`` for every owner, seeding
    from ``channels.wasm_channels`` so nothing already active gets dropped.

    Best-effort: a fresh install (DB not yet created) is fine — IronClaw's
    first run has no persisted set and honours config.toml. Any failure prints
    the manual remedy rather than aborting the install.
    """
    db_path = resolve_libsql_path(home)
    if not db_path.exists():
        print("  = ironclaw.db not present yet; first `ironclaw run` will honour config.toml")
        return
    try:
        con = sqlite3.connect(str(db_path), timeout=10)
        try:
            con.execute("PRAGMA busy_timeout = 10000")
            has_settings = con.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'"
            ).fetchone()
            if not has_settings:
                print("  = settings table absent; first `ironclaw run` will honour config.toml")
                return
            owners = [r[0] for r in con.execute("SELECT DISTINCT user_id FROM settings")] or [
                "default"
            ]
            for uid in owners:
                active = _read_setting_json(con, uid, "activated_channels")
                if active is None:
                    # No authoritative row yet: seed from the configured set so
                    # anything relying on the fallback stays active.
                    active = _read_setting_json(con, uid, "channels.wasm_channels") or []
                if not isinstance(active, list):
                    active = []
                if CHANNEL_NAME in active:
                    continue
                active.append(CHANNEL_NAME)
                con.execute(
                    "INSERT INTO settings (user_id, key, value) "
                    "VALUES (?, 'activated_channels', ?) "
                    "ON CONFLICT(user_id, key) DO UPDATE SET "
                    "value = excluded.value, "
                    "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
                    (uid, json.dumps(active)),
                )
                print(f"  ~ db activated_channels[{uid}] += clawbits")
            con.commit()
        finally:
            con.close()
    except Exception as exc:  # best-effort: never abort the install over this
        print(f"  ! could not update activated_channels in {db_path} ({exc})")
        print("    run manually: ironclaw config set activated_channels '[\"clawbits\"]'")


def exchange_signup(endpoint: str, org_id: str, signup_token: str) -> dict:
    out = subprocess.check_output(
        [
            sys.executable,
            str(ROOT / "onboarding_message.py"),
            "--endpoint",
            endpoint,
            "--signup-only",
            "--org-id",
            org_id,
            "--signup-token",
            signup_token,
        ],
        cwd=ROOT,
        text=True,
    )
    return json.loads(out)


def resolve_api_key(home: Path, manifest: Path, args: argparse.Namespace) -> str:
    env_file = home / ".env"
    env_file.parent.mkdir(parents=True, exist_ok=True)
    env_file.touch(exist_ok=True)
    file_env = parse_env_file(env_file)
    endpoint = endpoint_from_manifest(manifest)

    explicit_key = args.api_key or os.environ.get("CLAWBITS_API_KEY")
    org_id = args.org_id or os.environ.get("CLAWBITS_ORG_ID")
    signup_token = args.signup_token or os.environ.get("CLAWBITS_SIGNUP_TOKEN")
    want_new_key = args.replace_api_key or args.new_agent
    replace = want_new_key or bool(explicit_key) or bool(signup_token)

    api_key = file_env.get("CLAWBITS_API_KEY", "")
    agent_id = ""

    if org_id and signup_token and replace:
        created = exchange_signup(endpoint, org_id, signup_token)
        api_key = str(created.get("api_key") or "")
        agent_id = str(created.get("agent_id") or "")
        if not api_key:
            raise SystemExit("signup response missing api_key")
        print(f"  + Clawbits signup completed{f' for {agent_id}' if agent_id else ''}")
    elif explicit_key:
        api_key = explicit_key
    elif want_new_key and sys.stdin.isatty():
        import getpass

        api_key = getpass.getpass("New Clawbits agent API key: ")
    elif want_new_key:
        raise SystemExit("--new-agent/--replace-api-key requires --api-key or --org-id/--signup-token")
    elif not api_key and sys.stdin.isatty():
        import getpass

        api_key = getpass.getpass("Clawbits agent API key: ")

    if api_key:
        action = upsert_env(env_file, "CLAWBITS_API_KEY", api_key)
        print(f"  {action} CLAWBITS_API_KEY")
    else:
        print(f"  ! no API key provided — set CLAWBITS_API_KEY in {env_file}")
    return api_key


def activate_files(home: Path) -> None:
    env_file = home / ".env"
    action = upsert_env(env_file, "WASM_CHANNELS_ENABLED", "true")
    print(f"  {action} WASM_CHANNELS_ENABLED")
    action = ensure_env_list(env_file, "WASM_CHANNELS", CHANNEL_NAME)
    print(f"  {action} WASM_CHANNELS")
    update_config_toml(home / "config.toml")
    activate_in_db(home)


def reset_state(home: Path) -> None:
    channels_dir = home / "channels"
    greeted = channels_dir / ".clawbits-greeted-agents"
    if greeted.exists():
        greeted.unlink()
        print("  - greeting state")
    # Runtime watermarks are in-memory unless IronClaw adds durable paths later.


def post_greeting(home: Path, manifest: Path, api_key: str, args: argparse.Namespace) -> None:
    if args.skip_greeting or env_truthy("CLAWBITS_SKIP_ONBOARDING_MESSAGE"):
        print("  = onboarding greeting skipped")
        return
    if not api_key:
        return
    endpoint = endpoint_from_manifest(manifest)
    env = os.environ.copy()
    env["CLAWBITS_API_KEY"] = api_key
    env["CLAWBITS_ENDPOINT"] = endpoint
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "onboarding_message.py"),
            "--state-file",
            str(home / "channels" / ".clawbits-greeted-agents"),
        ],
        cwd=ROOT,
        env=env,
        text=True,
    )
    if result.returncode != 0:
        print("  ! continuing without onboarding greeting")


def cmd_install(args: argparse.Namespace) -> None:
    home = ironclaw_home()
    build(force=args.build, no_build=args.no_build)
    manifest = install_artifacts(home, args)
    activate_files(home)
    api_key = resolve_api_key(home, manifest, args)
    if args.reset_state or args.new_agent:
        reset_state(home)
    post_greeting(home, manifest, api_key, args)
    print_next_steps(home)


def cmd_configure(args: argparse.Namespace) -> None:
    home = ironclaw_home()
    manifest_path = home / "channels" / "clawbits.capabilities.json"
    if not manifest_path.exists():
        raise SystemExit("channel not installed; run install first")
    manifest = patched_manifest(
        manifest_path,
        manifest_path,
        endpoint=args.endpoint or os.environ.get("CLAWBITS_ENDPOINT"),
        agent_id=args.agent_id,
        clear_agent_id=args.clear_agent_id or args.new_agent,
        org_id=args.org_id or os.environ.get("CLAWBITS_ORG_ID"),
        channel_id=args.channel_id,
        clear_channel_id=args.clear_channel_id,
        allow_from=parse_allow_from(args.allow_from),
        poll_interval_ms=args.poll_interval_ms,
        preserve_existing=not args.new_agent,
    )
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Configured {manifest_path}")
    print(f"  ~ endpoint = {manifest['config']['endpoint']}")
    activate_files(home)
    api_key = resolve_api_key(home, manifest_path, args)
    if args.reset_state or args.new_agent:
        reset_state(home)
    post_greeting(home, manifest_path, api_key, args)
    print_next_steps(home)


def cmd_reset_state(args: argparse.Namespace) -> None:
    reset_state(ironclaw_home())


def cmd_status(args: argparse.Namespace) -> None:
    home = ironclaw_home()
    env_file = home / ".env"
    manifest = home / "channels" / "clawbits.capabilities.json"
    env = parse_env_file(env_file)
    print(f"home: {home}")
    print(f"wasm: {'yes' if (home / 'channels' / 'clawbits.wasm').exists() else 'no'}")
    print(f"manifest: {'yes' if manifest.exists() else 'no'}")
    if manifest.exists():
        data = load_json(manifest)
        print(f"endpoint: {data.get('config', {}).get('endpoint')}")
        print(f"channel_id: {data.get('config', {}).get('channel_id')}")
        print(f"allow_from: {json.dumps(data.get('config', {}).get('allow_from', []))}")
        print(f"poll_interval_ms: {data.get('config', {}).get('poll_interval_ms')}")
    print(f"env CLAWBITS_API_KEY: {mask(env.get('CLAWBITS_API_KEY', ''))}")
    print(f"env WASM_CHANNELS_ENABLED: {env.get('WASM_CHANNELS_ENABLED', '')}")
    print(f"env WASM_CHANNELS: {env.get('WASM_CHANNELS', '')}")
    print(f"config.toml: {'yes' if (home / 'config.toml').exists() else 'no'}")


def print_next_steps(home: Path) -> None:
    print()
    print("Done. Restart full IronClaw:")
    print("    ironclaw run")
    print("Boot screen should show: channels  clawbits")
    print()
    print("New agent/reconfigure example:")
    print("    ./clawbits-ironclaw reinstall --new-agent --endpoint https://app.clawbits.ai --org-id org_... --signup-token human-...")


def add_common_config_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--endpoint", default=None, help="Clawbits API endpoint")
    parser.add_argument("--api-key", default=None, help="Clawbits agent API key")
    parser.add_argument("--replace-api-key", action="store_true", help="replace stored CLAWBITS_API_KEY")
    parser.add_argument("--org-id", default=None, help="Clawbits org id for signup")
    parser.add_argument("--signup-token", default=None, help="one-time signup token")
    parser.add_argument("--agent-id", default=None, help="explicit self agent id override")
    parser.add_argument("--clear-agent-id", action="store_true", help="clear explicit agent_id")
    parser.add_argument("--channel-id", default=None, help="poll only one Clawbits channel")
    parser.add_argument("--clear-channel-id", action="store_true", help="poll all visible channels")
    parser.add_argument("--allow-from", default=None, help="comma list or JSON array, e.g. human:1,agent:agent_x")
    parser.add_argument("--poll-interval-ms", type=int, default=None, help="poll interval, minimum 30000")
    parser.add_argument("--new-agent", action="store_true", help="overwrite existing Clawbits key/config and clear local state")
    parser.add_argument("--reset-state", action="store_true", help="clear local Clawbits installer state")
    parser.add_argument("--skip-greeting", action="store_true", help="skip one-shot Clawbits greeting")


def main() -> int:
    parser = argparse.ArgumentParser(description="Build/install/reconfigure the IronClaw Clawbits channel")
    sub = parser.add_subparsers(dest="cmd", required=True)

    install = sub.add_parser("install", help="build if needed, install, activate")
    add_common_config_args(install)
    install.add_argument("--build", action="store_true", help="force rebuild before install")
    install.add_argument("--no-build", action="store_true", help="do not build; require existing clawbits.wasm")
    install.set_defaults(func=cmd_install)

    reinstall = sub.add_parser("reinstall", help="force rebuild, reinstall, reconfigure")
    add_common_config_args(reinstall)
    reinstall.add_argument("--build", action="store_true", default=True, help="force rebuild before install")
    reinstall.add_argument("--no-build", action="store_true", help="do not build; require existing clawbits.wasm")
    reinstall.set_defaults(func=cmd_install)

    configure = sub.add_parser("configure", help="reconfigure installed channel")
    add_common_config_args(configure)
    configure.set_defaults(func=cmd_configure)

    reset = sub.add_parser("reset-state", help="clear local installer state")
    reset.set_defaults(func=cmd_reset_state)

    status = sub.add_parser("status", help="show install status")
    status.set_defaults(func=cmd_status)

    args = parser.parse_args()
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
