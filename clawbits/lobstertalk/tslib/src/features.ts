import { murmurhash3_x86_32 } from "./murmurhash3";
import type { ChatContext } from "./types";

const FEATURE_DIM = 64;

/**
 * Deterministic mapping function P(C) -> X in R^64.
 *
 * Feature layout (matches `LobsterTalkLLMProtocol.md` Section 2):
 *  - X[0..7]   sender one-hot (top-7 + other)
 *  - X[8..15]  previous sender one-hot (top-7 + other)
 *  - X[16]     bounded log Δt (cap at 1 hour)
 *  - X[17]     message length, normalized to 256 chars
 *  - X[18..49] keyword hashing (32 dims) using MurmurHash3_x86_32(token) mod 32
 *  - X[50]     mention flag (1 if @username matches an active user)
 *  - X[51..63] padding (zeros)
 */
export function extractFeatures(message: string, context?: ChatContext): Float32Array {
  if (message === null || message === undefined) {
    throw new TypeError("extractFeatures: message must be a non-null string.");
  }

  const vector = new Float32Array(FEATURE_DIM);

  const activeUsers = context?.activeUsers ?? [];

  // --- Sender / Previous Sender one-hot ---
  const userIndex = (name?: string): number => {
    if (!name) return 7;
    const idx = activeUsers.indexOf(name);
    return idx >= 0 && idx < 7 ? idx : 7;
  };

  vector[userIndex(context?.sender)] = 1.0;
  if (context?.previousSender) {
    vector[8 + userIndex(context.previousSender)] = 1.0;
  }

  // --- Time delta (X_16) ---
  if (!context || context.lastMessageTimestamp === undefined) {
    vector[16] = 1.0;
  } else {
    const dtSeconds = Math.max(0, (Date.now() - context.lastMessageTimestamp) / 1000);
    const bounded = Math.min(Math.log(1 + dtSeconds), Math.log(3600));
    vector[16] = bounded / Math.log(3600);
  }

  // --- Message length (X_17) ---
  vector[17] = Math.min(message.length, 256) / 256.0;

  // --- Keyword hashing (X_18..X_49) ---
  const cleanMessage = message.replace(/[^\w\s]/g, "").toLowerCase();
  const tokens = cleanMessage.split(/\s+/);
  for (const token of tokens) {
    if (!token) continue;
    const h = murmurhash3_x86_32(token, 0);
    const bucket = (h >>> 0) % 32;
    vector[18 + bucket] = 1.0;
  }

  // --- Mention flag (X_50) ---
  if (activeUsers.length > 0) {
    const activeLower = new Set(activeUsers.map((u) => u.toLowerCase()));
    const mentionRe = /@([A-Za-z0-9_]+)/g;
    for (;;) {
      const m = mentionRe.exec(message);
      if (!m) break;
      if (activeLower.has(m[1].toLowerCase())) {
        vector[50] = 1.0;
        break;
      }
    }
  }

  return vector;
}

