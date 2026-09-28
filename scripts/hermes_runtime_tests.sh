#!/usr/bin/env bash
#
# Run tests/hermes_runtime against real, pinned Hermes revisions.
#
#   scripts/hermes_runtime_tests.sh [min|current|<commit>]... [-- <pytest args>]
#
# Revisions default to every label in tests/hermes_runtime/HERMES_REVS. For each
# one the source is extracted into a cache outside the repo, a Python 3.13 venv
# is built from Hermes's own uv.lock, the plan's upstream regression files that
# exist at that revision run from the extracted tree, the automation catch-up
# tests run against that revision's real cron store, and then the Clawbits
# suite runs once per plugin layout.
#
# Environment:
#   HERMES_RUNTIME_LAYOUT  bundled | user | "bundled user" (default: both)
#   HERMES_RUNTIME_CACHE   source/venv cache
#                          (default: ${XDG_CACHE_HOME:-~/.cache}/clawbits-hermes-runtime)
#   HERMES_AGENT_SRC       local hermes-agent checkout, read with `git archive` only
#                          (default: <repo>/hermes-agent; otherwise the GitHub tarball)
set -euo pipefail
export UV_NO_CONFIG=1  # a global uv.toml (e.g. exclude-newer) must not re-resolve Hermes's pins

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
suite=$repo/tests/hermes_runtime
cache=${HERMES_RUNTIME_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/clawbits-hermes-runtime}
agent_src=${HERMES_AGENT_SRC:-$repo/hermes-agent}
layouts=${HERMES_RUNTIME_LAYOUT:-bundled user}
upstream=(
  tests/gateway/test_queue_consumption.py
  tests/gateway/test_interrupt_keeps_parked_internal_wake.py
  tests/gateway/test_async_delegation_session_binding.py
  tests/gateway/test_api_server_active_work_drain.py
  tests/gateway/test_pending_queue_spool.py
  tests/gateway/test_discord_triggering_note_persistence.py
  tests/gateway/test_scale_to_zero.py
  tests/gateway/test_status.py
  tests/cron/test_cron_delivery_redaction.py
  tests/cron/test_fire_claim_lost_after_delivery.py
  tests/tui_gateway/test_served_profile_child_env_authority.py
)

wanted=()
while (($#)); do
  if [[ $1 == -- ]]; then shift; break; fi
  wanted+=("$1"); shift
done
pytest_args=("$@")
if ((${#wanted[@]} == 0)); then
  mapfile -t wanted < <(awk '!/^#/ && NF >= 2 {print $2}' "$suite/HERMES_REVS")
fi

resolve() {  # label or commit -> "<commit> <label>"
  local hit
  hit=$(awk -v want="$1" '!/^#/ && ($1 == want || $2 == want) {print $1, $2; exit}' \
    "$suite/HERMES_REVS")
  if [[ -n $hit ]]; then echo "$hit"
  elif [[ $1 =~ ^[0-9a-f]{40}$ ]]; then echo "$1 custom"
  else
    echo "unknown Hermes revision '$1' (use a label from HERMES_REVS or a full commit)" >&2
    return 1
  fi
}

fetch() {  # commit -> $cache/src-<commit>
  local sha=$1 dest=$cache/src-$1
  [[ -d $dest ]] && return
  rm -rf "$dest.part" && mkdir -p "$dest.part"
  if git -C "$agent_src" cat-file -e "$sha^{commit}" 2>/dev/null; then
    git -C "$agent_src" archive --format=tar "$sha" | tar -x -C "$dest.part"
  else
    curl -fsSL "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/$sha" \
      | tar -xz --strip-components=1 -C "$dest.part"
  fi
  mv "$dest.part" "$dest"
}

venv_for() {  # commit -> $cache/venv-<commit>, synced from the revision's uv.lock
  local src=$cache/src-$1 venv=$cache/venv-$1
  [[ -f $venv/.synced ]] && return
  (cd "$src" && UV_PROJECT_ENVIRONMENT=$venv uv sync --frozen --no-dev --no-install-project \
    --extra dev --extra messaging --python 3.13 --quiet)
  uv pip install --python "$venv/bin/python" --no-deps --quiet -e "$src"
  touch "$venv/.synced"
}

mkdir -p "$cache"
status=0
for want in "${wanted[@]}"; do
  rev=$(resolve "$want")
  read -r sha label <<<"$rev"
  src=$cache/src-$sha
  python=$cache/venv-$sha/bin/python
  echo "== Hermes $label ($sha)"
  fetch "$sha"
  venv_for "$sha"

  present=()
  for file in "${upstream[@]}"; do
    if [[ -f $src/$file ]]; then present+=("$file")
    else echo "   upstream file absent at $label: $file"
    fi
  done
  if ((${#present[@]})); then
    echo "-- upstream regression files (${#present[@]}/${#upstream[@]})"
    home=$(mktemp -d)
    (cd "$src" && HERMES_HOME=$home "$python" -m pytest -q -p no:cacheprovider "${present[@]}") \
      || status=1
    rm -rf "$home"
  fi

  echo "-- tests/poc/test_hermes_automations_catchup.py (real Hermes cron)"
  (cd "$repo" && "$python" -m pytest -q -p no:cacheprovider \
    tests/poc/test_hermes_automations_catchup.py) || status=1

  for layout in $layouts; do
    echo "-- tests/hermes_runtime ($layout layout)"
    HERMES_RUNTIME_REV=$sha HERMES_RUNTIME_LABEL=$label HERMES_RUNTIME_LAYOUT=$layout \
      "$python" -m pytest -q "$suite" "${pytest_args[@]}" || status=1
  done
done
exit "$status"
