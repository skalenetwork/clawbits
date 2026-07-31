#!/usr/bin/env bash
set -euo pipefail


SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

PYTHON_BIN="${PYTHON_BIN:-}"
if [[ -z "${PYTHON_BIN}" ]]; then
  if [[ -x ".venv/bin/python" ]]; then
    PYTHON_BIN=".venv/bin/python"
  else
    PYTHON_BIN="python3"
  fi
fi

TEST_TARGETS=(
  "tests/fastapi"
)

PYTEST_IGNORES=(
  "--ignore=tests/fastapi/test_openapi_fix.py"
  "--ignore=tests/fastapi/test_human_ui.py"
)

exec "${PYTHON_BIN}" -m pytest -x "${PYTEST_IGNORES[@]}" "${TEST_TARGETS[@]}" "$@"

