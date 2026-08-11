#!/usr/bin/env bash
# Package the IronClaw Clawbits channel into a self-contained install tarball.
#
# Produces <out-dir>/clawbits-ironclaw-<version>.tar.gz containing everything a
# host needs to *install* the channel onto a (hosted) IronClaw agent — the
# prebuilt WASM component, its capabilities manifest, and the Python
# installer/onboarding helper — but NOT the Rust sources or build toolchain.
# A consumer only needs python3 + ironclaw:
#
#     tar xzf clawbits-ironclaw-<version>.tar.gz
#     cd clawbits-ironclaw-<version>
#     ./clawbits-ironclaw install --endpoint https://app.clawbits.ai --api-key ck_...
#     ironclaw run
#
# Requires clawbits.wasm to exist (run ./build.sh first — the channel is built
# from source, never committed as a binary). Version is read from
# clawbits.capabilities.json.
#
# Usage: ./package.sh [out-dir]   (default out-dir: dist)
#
# Note: the reproducible-tar flags below are GNU tar; run on Linux/CI.
set -euo pipefail
cd "$(dirname "$0")"

OUT_DIR="${1:-dist}"

if [ ! -f clawbits.wasm ]; then
  echo "error: clawbits.wasm missing — run ./build.sh first" >&2
  exit 1
fi

VERSION="$(python3 -c "import json; print(json.load(open('clawbits.capabilities.json'))['version'])")"
NAME="clawbits-ironclaw-${VERSION}"

# Files that must travel to a host that only *installs* (no build toolchain).
# src/known_answers.rs is required at install time — NOT just a build source:
# onboarding_message.py parses it to solve the signup/greeting auth challenges
# (see README "Keeping in sync with Clawbits / IronClaw").
FILES=(
  clawbits.wasm
  clawbits.capabilities.json
  clawbits-ironclaw
  install.sh
  clawbits_ironclaw.py
  onboarding_message.py
  src/known_answers.rs
  README.md
)

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
DEST="$STAGE/$NAME"
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "error: expected file missing: $f" >&2
    exit 1
  fi
  mkdir -p "$DEST/$(dirname "$f")"
  cp "$f" "$DEST/$f"
done

mkdir -p "$OUT_DIR"
ARCHIVE="$OUT_DIR/${NAME}.tar.gz"

# Reproducible archive: stable entry order, no uid/gid, fixed mtime, and
# `gzip -n` so the gzip header carries no timestamp.
MTIME="@${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || echo 0)}"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="$MTIME" \
    --use-compress-program='gzip -9 -n' \
    -C "$STAGE" -cf "$ARCHIVE" "$NAME"

echo "Packaged $ARCHIVE"
( cd "$OUT_DIR" && sha256sum "${NAME}.tar.gz" | tee "${NAME}.tar.gz.sha256" )
