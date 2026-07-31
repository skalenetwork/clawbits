#!/usr/bin/env python3
"""Propagate marketing versions into iOS / Android / Cargo.lock.

Run this after bumping a "leader" version (``apps/mobile/package.json``
or ``desktop/src-tauri/Cargo.toml``). It mirrors that version into the
gnarly platform-specific files that carry the same version in
non-standard locations:

Mobile (Expo + native iOS/Android)
----------------------------------
Leader  : ``apps/mobile/package.json`` ``$.version``
Targets :
    - ``apps/mobile/ios/Clawbits/Info.plist``
        ``CFBundleShortVersionString`` (marketing version)
        ``CFBundleVersion``             (build number — monotonic +1)
    - ``apps/mobile/ios/Clawbits.xcodeproj/project.pbxproj``
        ``MARKETING_VERSION``          (×2: Debug + Release configs)
        ``CURRENT_PROJECT_VERSION``    (×2 — monotonic +1)
    - ``apps/mobile/android/app/build.gradle``
        ``versionName``  (marketing)
        ``versionCode``  (build number — monotonic +1)

Desktop (Tauri)
---------------
Leader  : ``desktop/src-tauri/Cargo.toml`` ``[package].version``
Targets :
    - ``desktop/src-tauri/Cargo.lock``  the ``[[package]] name = "clawbits"`` entry

Idempotent
----------
The script reads each "leader" and compares it to the "target". If they
already agree, the file is left untouched. Build numbers are only
incremented when the marketing version actually changes — running the
script twice in a row will NOT double-bump.

Build numbers
-------------
``CFBundleVersion``, ``CURRENT_PROJECT_VERSION``, and Android
``versionCode`` are monotonic integers, independent of semver. They
exist so the App Store / TestFlight / Play Console can distinguish
multiple uploads at the same marketing version. The script bumps each
by 1 per marketing change. Never decrements; never re-uses.
"""
from __future__ import annotations

import json
import plistlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

MOBILE_PKG          = ROOT / "apps/mobile/package.json"
MOBILE_INFO_PLIST   = ROOT / "apps/mobile/ios/Clawbits/Info.plist"
MOBILE_PBXPROJ      = ROOT / "apps/mobile/ios/Clawbits.xcodeproj/project.pbxproj"
MOBILE_GRADLE       = ROOT / "apps/mobile/android/app/build.gradle"
DESKTOP_CARGO_TOML  = ROOT / "desktop/src-tauri/Cargo.toml"
DESKTOP_CARGO_LOCK  = ROOT / "desktop/src-tauri/Cargo.lock"


def _read_json_version(path: Path) -> str:
    return json.loads(path.read_text())["version"]


def _read_cargo_package_version(path: Path) -> str:
    """Pull ``version = "..."`` from the ``[package]`` section."""
    text = path.read_text()
    m = re.search(
        r'\[package\][^\[]*?^\s*version\s*=\s*"([^"]+)"',
        text,
        re.MULTILINE | re.DOTALL,
    )
    if not m:
        raise ValueError(f"couldn't find [package].version in {path}")
    return m.group(1)


# ---------------------------------------------------------------------------
# Mobile (Expo + native)
# ---------------------------------------------------------------------------


def _sync_mobile() -> bool:
    new_version = _read_json_version(MOBILE_PKG)

    plist = plistlib.loads(MOBILE_INFO_PLIST.read_bytes())
    current_marketing = plist.get("CFBundleShortVersionString")
    if current_marketing == new_version:
        print(f"[mobile] already at {new_version}; no changes")
        return False

    current_build = int(plist.get("CFBundleVersion", "0"))
    new_build = current_build + 1
    print(
        f"[mobile] marketing {current_marketing} → {new_version}; "
        f"build {current_build} → {new_build}"
    )

    # --- Info.plist (binary-safe round-trip via plistlib) ---
    plist["CFBundleShortVersionString"] = new_version
    plist["CFBundleVersion"] = str(new_build)
    MOBILE_INFO_PLIST.write_bytes(plistlib.dumps(plist))

    # --- pbxproj (text replace) ---
    # Both MARKETING_VERSION and CURRENT_PROJECT_VERSION appear twice —
    # once per build configuration (Debug, Release). re.sub with no
    # count argument rewrites every occurrence in one pass.
    pbxproj = MOBILE_PBXPROJ.read_text()
    pbxproj = re.sub(
        r'(MARKETING_VERSION\s*=\s*)[^;]+(;)',
        rf'\g<1>{new_version}\g<2>',
        pbxproj,
    )
    pbxproj = re.sub(
        r'(CURRENT_PROJECT_VERSION\s*=\s*)\d+(;)',
        rf'\g<1>{new_build}\g<2>',
        pbxproj,
    )
    MOBILE_PBXPROJ.write_text(pbxproj)

    # --- build.gradle (text replace) ---
    gradle = MOBILE_GRADLE.read_text()
    gradle = re.sub(
        r'(versionName\s+)"[^"]+"',
        rf'\g<1>"{new_version}"',
        gradle,
    )
    gradle = re.sub(
        r'(versionCode\s+)\d+',
        rf'\g<1>{new_build}',
        gradle,
    )
    MOBILE_GRADLE.write_text(gradle)
    return True


# ---------------------------------------------------------------------------
# Desktop (Tauri's Cargo.lock)
# ---------------------------------------------------------------------------


def _sync_desktop() -> bool:
    new_version = _read_cargo_package_version(DESKTOP_CARGO_TOML)
    lock_text = DESKTOP_CARGO_LOCK.read_text()

    # Target the ``clawbits`` crate entry specifically. The Cargo.lock
    # format puts ``name = "X"`` and ``version = "..."`` on adjacent
    # lines inside a ``[[package]]`` table. Anchor on the name so we
    # don't accidentally rewrite a dep that happens to be at the same
    # version.
    pattern = r'(name\s*=\s*"clawbits"\s*\nversion\s*=\s*)"[^"]+"'
    new_lock = re.sub(pattern, rf'\g<1>"{new_version}"', lock_text)
    if new_lock == lock_text:
        print(f"[desktop] Cargo.lock already at {new_version}")
        return False
    print(f"[desktop] Cargo.lock clawbits → {new_version}")
    DESKTOP_CARGO_LOCK.write_text(new_lock)
    return True


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def main() -> int:
    mobile_changed = _sync_mobile()
    desktop_changed = _sync_desktop()
    if not (mobile_changed or desktop_changed):
        print("nothing to sync")
    return 0


if __name__ == "__main__":
    sys.exit(main())
