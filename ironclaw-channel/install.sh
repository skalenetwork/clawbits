#!/usr/bin/env bash
# Back-compat wrapper. Prefer: ./clawbits-ironclaw install ...
set -euo pipefail
cd "$(dirname "$0")"
exec python3 ./clawbits_ironclaw.py install "$@"
