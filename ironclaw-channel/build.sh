#!/usr/bin/env bash
# Build the Clawbits channel WASM component
#
# Prerequisites:
#   - Rust with wasm32-wasip2 target: rustup target add wasm32-wasip2
#   - wasm-tools for component creation: cargo install wasm-tools
#
# Output:
#   - clawbits.wasm - WASM component ready for deployment
#   - clawbits.capabilities.json - Capabilities file (copy alongside .wasm)

set -euo pipefail

cd "$(dirname "$0")"

echo "Building Clawbits channel WASM component..."

# Build the WASM module
cargo build --release --target wasm32-wasip2

# Convert to component model (if not already a component)
# wasm-tools component new is idempotent on components
WASM_PATH="target/wasm32-wasip2/release/clawbits_channel.wasm"

if [ -f "$WASM_PATH" ]; then
    # Create component if needed
    wasm-tools component new "$WASM_PATH" -o clawbits.wasm 2>/dev/null || cp "$WASM_PATH" clawbits.wasm

    # Optimize the component
    wasm-tools strip clawbits.wasm -o clawbits.wasm

    echo "Built: clawbits.wasm ($(du -h clawbits.wasm | cut -f1))"
    echo ""
    echo "To install:"
    echo "  ./clawbits-ironclaw install --api-key ck_..."
    echo ""
    echo "To reinstall/reconfigure:"
    echo "  ./clawbits-ironclaw reinstall --new-agent --org-id org_... --signup-token human-..."
else
    echo "Error: WASM output not found at $WASM_PATH"
    exit 1
fi
