# LobsterTalk TypeScript Library — Developer Manual

## Overview
- Implements deterministic feature mapping `P(C) -> X` (64-dim float vector)
- Loads and runs quantized ONNX model (`lobstertalk_int8.onnx`) for addressee prediction
- Used by OpenClaw plugins for local inference

## Directory Structure
- `src/` — TypeScript sources
  - `features.ts` — feature extraction logic
  - `murmurhash3.ts` — MurmurHash3_x86_32 implementation
  - `LobsterTalkPlugin.ts` — ONNX inference wrapper
  - `types.ts` — type definitions
  - `index.ts` — exports
- `test/` — Node.js+TSX tests (see README)
- `dist/` — compiled JS output
- `lobstertalk_int8.onnx` — quantized ONNX model (required for inference)

## Key APIs

### Feature Extraction
```ts
import { extractFeatures } from "@clawbits/lobstertalk";
const vec = extractFeatures("hello world", { sender: "alice", activeUsers: ["alice", "bob"] });
// vec: Float32Array[64]
```

### Inference
```ts
import { LobsterTalkPlugin } from "@clawbits/lobstertalk";
const plugin = new LobsterTalkPlugin();
await plugin.initialize("../lobstertalk_int8.onnx");
const result = await plugin.predictAddressee("hello", { sender: "alice", activeUsers: ["alice"] });
// result: { targetClass: number | "AMBIGUOUS", confidence: number }
```

## Testing
- Run all tests: `npm test`
- Tests cover feature extraction, hashing, ONNX inference, error handling

## Adding Features
- Add new feature logic in `features.ts`
- Update `ChatContext` in `types.ts` if new context fields needed
- Add/modify tests in `test/features.test.ts`

## ONNX Model
- Place `lobstertalk_int8.onnx` in the parent dir
- Model must match feature layout in `features.ts`

## Troubleshooting
- If ONNX inference fails: check model path, install `onnxruntime-node`
- For test failures: run with `DEBUG=1` for verbose output

## Contact
- Maintainer: @clawbits
- Issues: open in main repo

