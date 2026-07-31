"""LobsterTalk Student training script.

This implements the deterministic feature mapping P(C)->X described in
`LobsterTalkLLMProtocol.md` (Section 2) and trains the Student MLP (Section 3)
using distillation labels from `synthetic_corpus.json` (Section 1.2).

The goal is NOT to learn language, but to map engineered features to the teacher
probability distribution.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch
from torch.utils.data import DataLoader, Dataset

from clawbits.lobstertalk.student import (
    LobsterTalkStudent,
    distillation_loss,
    export_and_quantize,
    map_labels_to_tensor,
)

FEATURE_DIM = 64
NUM_CLASSES = 10


# --- MurmurHash3_x86_32 (seed=0) ---
# Matches the JS/TS `murmurhash.v3` behavior used in the spec.
# Public domain-style reference implementations exist; this is a compact Python port.

def _rotl32(x: int, r: int) -> int:
    return ((x << r) & 0xFFFFFFFF) | (x >> (32 - r))


def murmurhash3_x86_32(data: str, seed: int = 0) -> int:
    key = data.encode("utf-8")
    length = len(key)
    nblocks = length // 4

    h1 = seed & 0xFFFFFFFF

    c1 = 0xCC9E2D51
    c2 = 0x1B873593

    # body
    for block_start in range(0, nblocks * 4, 4):
        k1 = (
            key[block_start]
            | (key[block_start + 1] << 8)
            | (key[block_start + 2] << 16)
            | (key[block_start + 3] << 24)
        )
        k1 &= 0xFFFFFFFF

        k1 = (k1 * c1) & 0xFFFFFFFF
        k1 = _rotl32(k1, 15)
        k1 = (k1 * c2) & 0xFFFFFFFF

        h1 ^= k1
        h1 = _rotl32(h1, 13)
        h1 = (h1 * 5 + 0xE6546B64) & 0xFFFFFFFF

    # tail
    tail = key[nblocks * 4 :]
    k1 = 0
    if len(tail) == 3:
        k1 ^= tail[2] << 16
        k1 ^= tail[1] << 8
        k1 ^= tail[0]
    elif len(tail) == 2:
        k1 ^= tail[1] << 8
        k1 ^= tail[0]
    elif len(tail) == 1:
        k1 ^= tail[0]

    if len(tail) > 0:
        k1 &= 0xFFFFFFFF
        k1 = (k1 * c1) & 0xFFFFFFFF
        k1 = _rotl32(k1, 15)
        k1 = (k1 * c2) & 0xFFFFFFFF
        h1 ^= k1

    # finalization
    h1 ^= length

    # fmix
    h1 ^= h1 >> 16
    h1 = (h1 * 0x85EBCA6B) & 0xFFFFFFFF
    h1 ^= h1 >> 13
    h1 = (h1 * 0xC2B2AE35) & 0xFFFFFFFF
    h1 ^= h1 >> 16

    return h1 & 0xFFFFFFFF


_WORD_CLEAN_RE = re.compile(r"[^\w\s]", re.UNICODE)
_MENTION_RE = re.compile(r"@([A-Za-z0-9_]+)")


def extract_features(
    *,
    message: str,
    sender: str,
    prev_sender: str | None,
    dt_seconds: float | None,
    active_users: list[str],
) -> torch.Tensor:
    """Deterministic mapping P(C)->X in R^64.

    Conforms to Section 2 of the spec.

    Layout:
      - X[0:8]   sender one-hot (top-7 + other)
      - X[8:16]  previous-sender one-hot (top-7 + other)
      - X[16]    time delta feature, bounded log scaling to 1h
      - X[17]    message length, min-max normalized to 256 chars
      - X[18:50] keyword hashing (32 dims)
      - X[50]    mention flag
      - X[51:64] padding (zeros)
    """

    if message is None:
        raise TypeError("message must be a non-null string")

    x = torch.zeros(FEATURE_DIM, dtype=torch.float32)

    # --- sender one-hot (X_0..X_7) ---
    def _user_index(name: str) -> int:
        try:
            idx = active_users.index(name)
        except ValueError:
            return 7
        return idx if idx < 7 else 7

    sender_idx = _user_index(sender)
    x[sender_idx] = 1.0

    # --- previous sender one-hot (X_8..X_15) ---
    if prev_sender is not None:
        prev_idx = _user_index(prev_sender)
        x[8 + prev_idx] = 1.0

    # --- time delta (X_16) ---
    if dt_seconds is None:
        x[16] = 1.0  # null-state fallback
    else:
        dt_seconds = max(0.0, float(dt_seconds))
        bounded = min(math.log(1.0 + dt_seconds), math.log(3600.0))
        x[16] = bounded / math.log(3600.0)

    # --- message length (X_17) ---
    x[17] = min(len(message), 256) / 256.0

    # --- keyword hashing (X_18..X_49) ---
    clean = _WORD_CLEAN_RE.sub("", message).lower()
    tokens = [t for t in clean.split() if t]
    for token in tokens:
        h = murmurhash3_x86_32(token, seed=0)
        bucket = int(h % 32)
        x[18 + bucket] = 1.0

    # --- mention flag (X_50) ---
    # Binary 1 if @username triggers for an active user (case-insensitive).
    active_lower = {u.lower(): u for u in active_users}
    for m in _MENTION_RE.finditer(message):
        if m.group(1).lower() in active_lower:
            x[50] = 1.0
            break

    return x


@dataclass(frozen=True)
class Example:
    x: torch.Tensor  # (64,)
    y: torch.Tensor  # (10,)


def _pick_active_users(thread: dict[str, Any]) -> list[str]:
    senders = [m.get("sender") for m in thread.get("messages", []) if isinstance(m, dict)]
    counts = Counter([s for s in senders if isinstance(s, str)])
    # Deterministic sort: count desc, then name asc
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [name for name, _ in ordered[:7]]


def _pick_context_subgroup(thread: dict[str, Any]) -> str:
    # Section 3: Index 8 maps to the active Context Subgroup.
    # Our synthetic corpora usually store subgroup/role as values in persona_map.
    persona_map = thread.get("persona_map")
    if isinstance(persona_map, dict):
        values = [v for v in persona_map.values() if isinstance(v, str) and v]
        if values:
            counts = Counter(values)
            return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]

    # Fallback: infer from target_probs keys not equal to a participant nor "global".
    participants = set()
    if isinstance(persona_map, dict):
        participants.update([k for k in persona_map if isinstance(k, str)])

    subgroup_counts: Counter[str] = Counter()
    for m in thread.get("messages", []) if isinstance(thread.get("messages"), list) else []:
        if not isinstance(m, dict):
            continue
        tp = (m.get("metadata") or {}).get("target_probs") if isinstance(m.get("metadata"), dict) else None
        if not isinstance(tp, dict):
            continue
        for k in tp:
            if isinstance(k, str) and k != "global" and k not in participants:
                subgroup_counts[k] += 1

    if subgroup_counts:
        return sorted(subgroup_counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]

    return ""  # no subgroup present


def iter_examples_from_corpus(corpus: list[dict[str, Any]]) -> list[Example]:
    examples: list[Example] = []

    for thread in corpus:
        if not isinstance(thread, dict):
            continue

        messages = thread.get("messages")
        if not isinstance(messages, list) or not messages:
            continue

        active_users = _pick_active_users(thread)
        context_subgroup = _pick_context_subgroup(thread)

        prev_sender: str | None = None
        prev_t: float | None = None

        for msg in messages:
            if not isinstance(msg, dict):
                continue

            text = msg.get("text")
            sender = msg.get("sender")
            t = msg.get("timestamp_offset")
            metadata = msg.get("metadata")

            if not isinstance(text, str) or not isinstance(sender, str) or not isinstance(metadata, dict):
                prev_sender = sender if isinstance(sender, str) else prev_sender
                prev_t = float(t) if isinstance(t, (int, float)) else prev_t
                continue

            target_probs = metadata.get("target_probs")
            if not isinstance(target_probs, dict) or not target_probs:
                prev_sender = sender
                prev_t = float(t) if isinstance(t, (int, float)) else prev_t
                continue

            dt: float | None
            if prev_t is None or not isinstance(t, (int, float)):
                dt = None
            else:
                dt = float(t) - prev_t

            x = extract_features(
                message=text,
                sender=sender,
                prev_sender=prev_sender,
                dt_seconds=dt,
                active_users=active_users,
            )

            y = map_labels_to_tensor(target_probs, active_users, context_subgroup)
            examples.append(Example(x=x, y=y))

            prev_sender = sender
            prev_t = float(t) if isinstance(t, (int, float)) else prev_t

    return examples


class CorpusDataset(Dataset[tuple[torch.Tensor, torch.Tensor]]):
    def __init__(self, examples: list[Example]):
        self._examples = examples

    def __len__(self) -> int:  # noqa: D401
        return len(self._examples)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, torch.Tensor]:
        ex = self._examples[idx]
        return ex.x, ex.y


def train_student(
    *,
    corpus_path: Path,
    epochs: int,
    batch_size: int,
    lr: float,
    device: str,
    max_examples: int | None = None,
) -> LobsterTalkStudent:
    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    if not isinstance(corpus, list):
        raise ValueError("Corpus must be a JSON list of thread objects.")

    examples = iter_examples_from_corpus(corpus)
    if max_examples is not None:
        examples = examples[: max_examples]

    if not examples:
        raise ValueError(
            "No valid training examples were found in the corpus. "
            "Check that messages contain metadata.target_probs."
        )

    ds = CorpusDataset(examples)
    dl = DataLoader(ds, batch_size=batch_size, shuffle=True, drop_last=False)

    model = LobsterTalkStudent(input_dim=FEATURE_DIM, num_classes=NUM_CLASSES)
    model.to(device)

    opt = torch.optim.Adam(model.parameters(), lr=lr)

    for epoch in range(1, epochs + 1):
        model.train()
        total_loss = 0.0
        total_n = 0

        for xb, yb in dl:
            xb = xb.to(device)
            yb = yb.to(device)

            opt.zero_grad(set_to_none=True)
            logits = model(xb)
            loss = distillation_loss(logits, yb)
            loss.backward()
            opt.step()

            total_loss += float(loss.detach().cpu()) * xb.shape[0]
            total_n += xb.shape[0]

        avg_loss = total_loss / max(1, total_n)
        print(f"epoch={epoch} examples={total_n} avg_kld={avg_loss:.6f}")

    model.eval()
    return model


def main() -> int:
    parser = argparse.ArgumentParser(description="Train LobsterTalk Student from synthetic_corpus.json")
    parser.add_argument(
        "--corpus",
        type=Path,
        default=Path(__file__).with_name("synthetic_corpus.json"),
        help="Path to the synthetic corpus JSON file.",
    )
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument(
        "--device",
        type=str,
        default="cuda" if torch.cuda.is_available() else "cpu",
        help="cpu or cuda (if available)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).parent,
        help="Where to write model artifacts.",
    )
    parser.add_argument(
        "--max-examples",
        type=int,
        default=None,
        help="Optional cap for quick smoke runs.",
    )
    parser.add_argument(
        "--no-export",
        action="store_true",
        help="Train only; do not export/quantize ONNX.",
    )

    args = parser.parse_args()

    if args.epochs <= 0:
        raise ValueError("--epochs must be > 0")
    if args.batch_size <= 0:
        raise ValueError("--batch-size must be > 0")
    if args.lr <= 0:
        raise ValueError("--lr must be > 0")

    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    model = train_student(
        corpus_path=args.corpus,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        device=args.device,
        max_examples=args.max_examples,
    )

    # Save PyTorch weights.
    pt_path = out_dir / "lobstertalk_student.pt"
    torch.save(model.state_dict(), pt_path)
    print(f"saved: {pt_path}")

    if not args.no_export:
        fp32_path = out_dir / "lobstertalk_fp32.onnx"
        try:
            export_and_quantize(model, str(fp32_path))
        except Exception as e:  # noqa: BLE001
            # Known onnxruntime quantization issues can happen in some environments.
            print(f"WARNING: export/quantize failed: {e}")
            print(f"FP32 export path was: {fp32_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

