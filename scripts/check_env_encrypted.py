#!/usr/bin/env python3
"""Fail if a tracked ``.env.*`` file holds a secret in plaintext.

This exists because it already happened. ``.env.development`` was committed with
``CLOUDFLARE_API_TOKEN``, ``WORKOS_API_KEY`` and ``WORKOS_COOKIE_PASSWORD`` in
cleartext for months, after an earlier commit of the same file had them
correctly ``encrypted:``. Nothing caught the regression.

The rule is deny-by-default on the key *name*: anything that looks like a
credential must be empty, a ``${VAR}`` reference, or a dotenvx ``encrypted:``
blob. Names that are genuinely public are allowlisted explicitly below, so
adding a new secret is safe by default and adding a new public value is a
deliberate one-line change.

Usage:
    python scripts/check_env_encrypted.py [paths...]

With no arguments it checks every tracked ``.env*`` file except ``.env.example``.
Exits 1 on the first file with a violation.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# A key whose name matches any of these must not carry a plaintext value.
SECRET_NAME_RE = re.compile(
    r"(TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|_KEY$|^OPENAI_KEY$|API_KEY)",
    re.IGNORECASE,
)

# Names that match SECRET_NAME_RE but are public by design. Keep this list short
# and justify every entry — it is the only way a plaintext value gets through.
PUBLIC_ALLOWLIST = {
    # dotenvx's own public half; the whole point is that it is committed.
    *(f"DOTENV_PUBLIC_KEY_{env}" for env in ("DEVELOPMENT", "STAGING", "PRODUCTION")),
    # VAPID's public half is handed to the browser at subscribe time.
    "CLAWBITS_VAPID_PUBLIC_KEY",
    # OAuth client IDs are public by specification; the secrets are separate keys.
    "WORKOS_CLIENT_ID",
    "GITHUB_CONNECTOR_CLIENT_ID",
    # An account identifier, not a credential.
    "CLOUDFLARE_ACCOUNT_ID",
}

ASSIGN_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")

# Per-line escape hatch, so a waiver lives next to the thing it waives and
# carries its reason. Deliberately requires a non-empty reason:
#   STALWART_SVC_PASSWORD=dev-svc-secret  # check-env: allow-plaintext (reason)
WAIVER_RE = re.compile(r"#\s*check-env:\s*allow-plaintext\s*\((?P<reason>[^)]+)\)")


def _is_safe_value(raw: str) -> bool:
    """True when a value cannot be a plaintext secret."""
    v = raw.strip().strip('"').strip("'")
    if not v:
        return True  # empty placeholder
    if v.startswith("encrypted:"):
        return True  # dotenvx ciphertext
    # indirection to a real secret store
    return v.startswith("${") and v.endswith("}")


def check_file(path: Path) -> list[str]:
    problems: list[str] = []
    for lineno, line in enumerate(path.read_text().splitlines(), start=1):
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        m = ASSIGN_RE.match(line)
        if not m:
            continue
        key, value = m.group(1), m.group(2)
        if key in PUBLIC_ALLOWLIST:
            continue
        if not SECRET_NAME_RE.search(key):
            continue
        if WAIVER_RE.search(line):
            continue  # explicit, reasoned, per-line waiver
        if _is_safe_value(value):
            continue
        problems.append(f"{path}:{lineno}: {key} holds a plaintext value")
    return problems


def _tracked_env_files() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", ".env*", "**/.env*"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout
    return [
        Path(p)
        for p in out.split()
        if Path(p).name != ".env.example" and Path(p).exists()
    ]


def main(argv: list[str]) -> int:
    paths = [Path(a) for a in argv[1:]] or _tracked_env_files()
    paths = [p for p in paths if p.name != ".env.example" and p.exists()]
    if not paths:
        return 0

    problems: list[str] = []
    for p in paths:
        problems.extend(check_file(p))

    if problems:
        print("Plaintext secrets found in tracked env files:\n", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        print(
            "\nEncrypt each one with dotenvx, e.g.:\n"
            "  dotenvx set KEY 'value' -f .env.development\n"
            "\nIf a key is genuinely public, add it to PUBLIC_ALLOWLIST in\n"
            "scripts/check_env_encrypted.py with a one-line justification.",
            file=sys.stderr,
        )
        return 1

    print(f"OK — no plaintext secrets in {len(paths)} tracked env file(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
