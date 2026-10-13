#!/usr/bin/env bash
#
# Pre-build step for a deploy. Materialises the encrypted env file this build
# needs, from the private clawbits-internal checkout on the host.
#
#   scripts/deploy_prep.sh production
#
# Wire this into Komodo as the stack's pre-deploy command. It runs in the stack
# directory (the clawbits checkout) and must succeed before `docker compose
# up -d --build`.
#
# WHY IT EXISTS
# The per-env files are no longer committed to this repo — they live in
# clawbits-internal. Without this step the build context contains only
# .env.example, so `COPY .env.*` silently produces an image with no real
# config, and the container boots against development defaults.
#
# WHY IT IS LOUD
# Every failure below aborts the deploy. A deploy that half-works here is worse
# than one that does not start: the app would come up healthy on the wrong
# database URL, the wrong bucket, and the wrong auth tenant.
set -euo pipefail

cd "$(dirname "$0")/.."
repo_root="$(pwd)"

env_name="${1:-production}"
case "${env_name}" in
  development|staging|production) ;;
  *) echo "deploy_prep: unknown env '${env_name}'" >&2; exit 2 ;;
esac

internal="${CLAWBITS_INTERNAL:-/opt/clawbits-internal}"

if [ ! -d "${internal}/.git" ]; then
  cat >&2 <<EOF
deploy_prep: no clawbits-internal checkout at ${internal}

  Clone it once on this host, with a read-only deploy key:

    sudo git clone git@github.com:skalenetwork/clawbits-internal.git ${internal}

  Or set CLAWBITS_INTERNAL to an existing checkout.
EOF
  exit 1
fi

# Pull, so a rotated secret actually reaches this build. A failure here is
# fatal on purpose: building with a silently stale secret is the exact failure
# mode this script exists to prevent.
branch="$(git -C "${internal}" rev-parse --verify --quiet --abbrev-ref HEAD || true)"
if [ -z "${branch}" ] || [ "${branch}" = "HEAD" ]; then
  echo "deploy_prep: ${internal} has no commits on a branch." >&2
  echo "deploy_prep: push clawbits-internal first, then re-run the deploy." >&2
  exit 1
fi

echo "deploy_prep: updating ${internal} (${branch})"
if ! git -C "${internal}" fetch --quiet origin "${branch}"; then
  echo "deploy_prep: cannot fetch origin/${branch} from ${internal}." >&2
  echo "deploy_prep: check the deploy key on this host." >&2
  exit 1
fi
git -C "${internal}" reset --quiet --hard "origin/${branch}"
echo "deploy_prep: clawbits-internal at $(git -C "${internal}" rev-parse --short HEAD)"

# Remove any other env files first, so a prod image can never pick up staging
# or development ciphertext left behind by an earlier deploy of a different
# environment on this host.
for other in development staging production; do
  [ "${other}" = "${env_name}" ] && continue
  rm -f "${repo_root}/.env.${other}"
done

CLAWBITS_INTERNAL="${internal}" "${repo_root}/scripts/sync_env.sh" "${env_name}"

target="${repo_root}/.env.${env_name}"
[ -s "${target}" ] || { echo "deploy_prep: ${target} missing or empty after sync" >&2; exit 1; }

# The file must still be ciphertext. If a plaintext secret ever reaches a build
# context, that is worth failing a deploy over.
if [ -x "$(command -v python3)" ]; then
  python3 "${repo_root}/scripts/check_env_encrypted.py" "${target}" >/dev/null || {
    echo "deploy_prep: ${target} contains a plaintext secret — refusing to build" >&2
    exit 1
  }
fi

encrypted="$(grep -cE '=("?)encrypted:' "${target}" || true)"
echo "deploy_prep: ready — .env.${env_name} (${encrypted} encrypted values)"
