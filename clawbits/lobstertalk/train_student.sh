#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CORPUS_FILE="${1:-"$SCRIPT_DIR/synthetic_corpus.json"}"
EPOCHS="${2:-5}"
BATCH_SIZE="${3:-128}"
NO_EXPORT="${NO_EXPORT:-0}"

# Resolve to an absolute path (script later cd's to project root).
if command -v realpath >/dev/null 2>&1; then
  CORPUS_FILE="$(realpath "$CORPUS_FILE")"
else
  CORPUS_FILE="$(python -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$CORPUS_FILE")"
fi

# Prefer project venv if it exists
if [ -f "$PROJECT_ROOT/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/.venv/bin/activate"
fi

PYTHON_BIN="${PYTHON_BIN:-python}"

# Quick dependency check with a friendly error.
"$PYTHON_BIN" - << 'PY'
import importlib
missing = []
for mod in ["torch", "onnx", "onnxruntime"]:
    try:
        importlib.import_module(mod)
    except Exception:
        missing.append(mod)
if missing:
    raise SystemExit(
        "Missing Python deps: " + ", ".join(missing) + "\n"
        "Install (CPU-only torch example):\n"
        "  python -m pip install torch onnx onnxruntime onnxscript --index-url https://download.pytorch.org/whl/cpu\n"
    )
print("deps-ok")
PY

echo "Training LobsterTalk Student"
echo "  corpus:      $CORPUS_FILE"
echo "  epochs:      $EPOCHS"
echo "  batch_size:  $BATCH_SIZE"

echo "Artifacts will be written to: $SCRIPT_DIR"

# Run from project root so `import clawbits...` works.
cd "$PROJECT_ROOT"
export PYTHONPATH="$PROJECT_ROOT${PYTHONPATH:+:$PYTHONPATH}"

"$PYTHON_BIN" "$SCRIPT_DIR/train_student.py" \
  --corpus "$CORPUS_FILE" \
  --epochs "$EPOCHS" \
  --batch-size "$BATCH_SIZE" \
  --out-dir "$SCRIPT_DIR" \
  $([ "$NO_EXPORT" = "1" ] && echo "--no-export")

