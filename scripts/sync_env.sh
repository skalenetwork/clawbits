#!/usr/bin/env bash
#
# Copy dotenvx-encrypted env files from the private clawbits-internal repo into
# this working tree.
#
# The files are the source of truth THERE and gitignored HERE, so a sync can
# never re-publish them. Everything downstream is unchanged: dotenvx still
# decrypts them, the Dockerfile still COPYs them.
#
#   scripts/sync_env.sh                      # development (the default)
#   scripts/sync_env.sh production           # one env
#   scripts/sync_env.sh --all                # all three
#   scripts/sync_env.sh --check production   # exit 1 if the copy is stale
#
# Source repo resolution: $CLAWBITS_INTERNAL, else ../clawbits-internal.
#
# --check is the one that earns its keep. The copies are invisible to
# `git status` by design, so nothing else tells you a teammate rotated a value
# and your local copy is a week old — you just get a confusing 401.
set -euo pipefail

cd "$(dirname "$0")/.."
repo_root="$(pwd)"
internal="${CLAWBITS_INTERNAL:-${repo_root}/../clawbits-internal}"

check_only=0
envs=()

while [ $# -gt 0 ]; do
  case "$1" in
    --check)   check_only=1 ;;
    --all)     envs+=(development staging production) ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        echo "sync_env: unknown flag: $1" >&2; exit 2 ;;
    *)         envs+=("$1") ;;
  esac
  shift
done
[ ${#envs[@]} -eq 0 ] && envs=(development)

if [ ! -d "${internal}/env" ]; then
  cat >&2 <<EOF
sync_env: no env/ directory at ${internal}

  The encrypted files live in the private clawbits-internal repo. Clone it
  beside this one:

    git clone git@github.com:skalenetwork/clawbits-internal.git "${internal}"

  or point CLAWBITS_INTERNAL at an existing checkout.
EOF
  exit 1
fi

# Staleness of the SOURCE checkout itself — a current copy of an outdated
# source is still outdated. Advisory only: offline should not block a sync.
if git -C "${internal}" rev-parse --git-dir >/dev/null 2>&1; then
  if git -C "${internal}" fetch --quiet --dry-run 2>/dev/null; then
    # --verify --quiet: plain `rev-parse @` ECHOES BACK the literal "@" on a
    # repo with no commits rather than failing, which made this warn forever.
    local_head="$(git -C "${internal}" rev-parse --verify --quiet @ || true)"
    remote_head="$(git -C "${internal}" rev-parse --verify --quiet '@{u}' || true)"
    if [ -n "${remote_head}" ] && [ "${local_head}" != "${remote_head}" ]; then
      echo "sync_env: WARNING — ${internal} is not level with its remote." >&2
      echo "sync_env:           run: git -C ${internal} pull" >&2
    fi
  fi
fi

status=0
for env in "${envs[@]}"; do
  case "${env}" in
    development|staging|production) ;;
    *) echo "sync_env: unknown env '${env}' (development|staging|production)" >&2; exit 2 ;;
  esac

  src="${internal}/env/.env.${env}"
  dst="${repo_root}/.env.${env}"

  if [ ! -f "${src}" ]; then
    echo "sync_env: missing ${src}" >&2
    status=1
    continue
  fi

  if [ "${check_only}" -eq 1 ]; then
    if [ ! -f "${dst}" ]; then
      echo "sync_env: MISSING  .env.${env} (never synced)" >&2
      status=1
    elif ! cmp -s "${src}" "${dst}"; then
      echo "sync_env: STALE    .env.${env} differs from ${src}" >&2
      status=1
    else
      echo "sync_env: ok       .env.${env}"
    fi
    continue
  fi

  cp "${src}" "${dst}"
  chmod 600 "${dst}"
  echo "sync_env: synced   .env.${env}  ($(grep -cE '=("?)encrypted:' "${dst}") encrypted values)"
done

if [ "${check_only}" -eq 1 ] && [ "${status}" -ne 0 ]; then
  echo "sync_env: run 'scripts/sync_env.sh ${envs[*]}' to refresh" >&2
fi
exit "${status}"
