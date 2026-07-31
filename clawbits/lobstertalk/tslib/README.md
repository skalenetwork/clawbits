# @clawbits/lobstertalk (TypeScript inference library)

This is the TypeScript/Node.js inference implementation for the LobsterTalk protocol.

It implements the deterministic feature mapping `P(C) -> X` (64-dim float vector) and
runs the quantized ONNX student model (`lobstertalk_int8.onnx`) via `onnxruntime-node`.

## Used by

- `plugin/` (OpenClaw channel plugin) imports this library and uses it for local inference.

## Build (library only)

```bash
cd /d/clawbits/clawbits/lobstertalk/tslib
npx -p typescript@5.0.0 tsc -p tsconfig.json
```

## Tests

Tests live under `test/` and use Node's built-in test runner with `tsx` for TS loading.

```bash
cd /d/freeclaws/clawbits/lobstertalk/tslib
npm install
npm test
```

Coverage:

- `test/murmurhash3.test.ts` — known SMHasher vectors, determinism, seed sensitivity, tail-length variants.
- `test/features.test.ts` — feature-vector shape, sender / previous-sender one-hot, time delta saturation & monotonicity, length normalization, keyword hashing buckets, mention flag.
- `test/plugin.test.ts` — `LobsterTalkPlugin` uninitialized guard, invalid input guard, ONNX inference smoke + determinism (auto-skipped when `../lobstertalk_int8.onnx` is missing).


