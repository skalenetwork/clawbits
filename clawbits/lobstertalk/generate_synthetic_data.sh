#!/usr/bin/env bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Default number of threads to generate
NUM_THREADS=${1:-100}
OUTPUT_FILE=${2:-"$SCRIPT_DIR/synthetic_corpus.json"}

# Source .env file if it exists
if [ -f "$PROJECT_ROOT/.env" ]; then
    export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs)
fi

if [ -z "$GEMINI_API_KEY" ]; then
    echo "Error: GEMINI_API_KEY environment variable is not set."
    echo "Usage: GEMINI_API_KEY=your_key ./generate_synthetic_data.sh [NUM_THREADS] [OUTPUT_FILE]"
    exit 1
fi

echo "Installing required dependencies for Google Generative AI..."
# Ensure the dependency is installed in the python environment
cd "$PROJECT_ROOT"
# Use python if uv is missing
if command -v uv >/dev/null 2>&1; then
    uv pip install google-genai
    UV_OR_PYTHON="uv run python"
else
    python -m pip install google-genai
    UV_OR_PYTHON="python"
fi

echo "Starting synthetic data generation using Gemini 1.5 Flash..."
echo "Generating $NUM_THREADS threads to $OUTPUT_FILE"

$UV_OR_PYTHON "$SCRIPT_DIR/synthesize.py" --num-threads "$NUM_THREADS" --output "$OUTPUT_FILE"

echo "Data generation complete."
