#!/usr/bin/env python3
"""Unified version bump for the backend, frontend, and desktop apps.

One command sets the SAME semver across all three components and their
lockfiles. Mobile (``apps/mobile``) and the plugin (``plugin/package.json``)
version on their own cadence and are intentionally left untouched. This is a
manual product version, independent of the semantic-release git tags.

Usage::

    uv run python scripts/bump_version.py patch     # 0.4.0 -> 0.4.1
    uv run python scripts/bump_version.py minor     # 0.4.0 -> 0.5.0
    uv run python scripts/bump_version.py major     # 0.4.0 -> 1.0.0
    uv run python scripts/bump_version.py 0.4.0     # set explicitly
    uv run python scripts/bump_version.py minor --dry-run

The canonical current version is read from ``pyproject.toml`` ([project].version);
each file's own current value is shown in the summary so drift is visible.

Files written
-------------
  backend   pyproject.toml                       [project].version
            uv.lock                              the clawbits (virtual) package
  frontend  frontend/package.json                .version
  desktop   desktop/package.json                 .version
            desktop/src-tauri/tauri.conf.json    .version
            desktop/src-tauri/Cargo.toml         [package].version
            desktop/src-tauri/Cargo.lock         the clawbits crate

Each edit is anchored (TOML edits to their [section]; the lockfiles to the
``clawbits`` entry by name) so a dependency that happens to share a version is
never rewritten. Idempotent: re-running with the same target is a no-op.
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
VER = r"\d+\.\d+\.\d+"


@dataclass
class Target:
    path: Path
    label: str
    # Regex with three groups: (prefix)(version)(suffix). The version group is
    # swapped; prefix/suffix are preserved verbatim.
    pattern: str
    flags: int = field(default=re.MULTILINE)


def targets() -> list[Target]:
    return [
        Target(ROOT / "pyproject.toml", "backend   pyproject.toml",
               rf'(\[project\][^\[]*?\bversion\s*=\s*")({VER})(")', re.DOTALL),
        Target(ROOT / "uv.lock", "backend   uv.lock",
               rf'(name = "clawbits"\nversion = ")({VER})(")'),
        Target(ROOT / "frontend/package.json", "frontend  package.json",
               rf'(^\s*"version"\s*:\s*")({VER})(")'),
        Target(ROOT / "desktop/package.json", "desktop   package.json",
               rf'(^\s*"version"\s*:\s*")({VER})(")'),
        Target(ROOT / "desktop/src-tauri/tauri.conf.json", "desktop   tauri.conf.json",
               rf'(^\s*"version"\s*:\s*")({VER})(")'),
        Target(ROOT / "desktop/src-tauri/Cargo.toml", "desktop   Cargo.toml",
               rf'(\[package\][^\[]*?\bversion\s*=\s*")({VER})(")', re.DOTALL),
        Target(ROOT / "desktop/src-tauri/Cargo.lock", "desktop   Cargo.lock",
               rf'(name = "clawbits"\nversion = ")({VER})(")'),
    ]


def read_canonical() -> str:
    text = (ROOT / "pyproject.toml").read_text()
    m = re.search(rf'\[project\][^\[]*?\bversion\s*=\s*"({VER})"', text, re.DOTALL)
    if not m:
        sys.exit("error: couldn't read [project].version from pyproject.toml")
    return m.group(1)


def compute(current: str, bump: str) -> str:
    if SEMVER_RE.match(bump):
        return bump
    major, minor, patch = (int(x) for x in current.split("."))
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    sys.exit(f"error: invalid bump {bump!r} (use major | minor | patch | X.Y.Z)")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Bump backend + frontend + desktop to one unified version.",
    )
    ap.add_argument("bump", help="major | minor | patch | X.Y.Z")
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would change without writing")
    args = ap.parse_args()

    current = read_canonical()
    new = compute(current, args.bump)
    print(f"Unified version {current} -> {new}"
          f"{'  (dry run)' if args.dry_run else ''}\n")

    changed = 0
    missing = 0
    for t in targets():
        if not t.path.exists():
            print(f"  !  {t.label}: missing file ({t.path})")
            missing += 1
            continue
        text = t.path.read_text()
        m = re.search(t.pattern, text, t.flags)
        if not m:
            print(f"  !  {t.label}: version not found (pattern miss)")
            missing += 1
            continue
        old = m.group(2)
        if old == new:
            print(f"  =  {t.label}: already {new}")
            continue
        new_text = re.sub(t.pattern, rf"\g<1>{new}\g<3>", text, count=1, flags=t.flags)
        if not args.dry_run:
            t.path.write_text(new_text)
        print(f"  +  {t.label}: {old} -> {new}")
        changed += 1

    print()
    if missing:
        print(f"WARNING: {missing} target(s) could not be updated - check above.")
    if args.dry_run:
        print("Dry run - nothing written.")
    elif changed:
        print(f"Done: {changed} file(s) updated to {new}.")
        print("Mobile + plugin versions were left untouched (they bump separately).")
        print("Review with `git diff`, then commit.")
    else:
        print(f"Everything already at {new} - nothing to do.")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
