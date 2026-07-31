"""A/B utterance-set / aggregation configs for the LobsterTalk attention gate on
the fixed probe suite from lobstertalk_probe_gate.py.

The v1 baseline (the sets shipped before 2026-07-27, under semantic-router's
default mean aggregation) is frozen inline; "current" is whatever gate.py
ships now. Add candidate configs to CONFIGS to evaluate future changes.

One encoder pass; scoring replicates semantic-router v0.1.2 exactly (top_k=5
across all utterances, group by route, aggregate, argmax; threshold on the
aggregate) — validated against the real router by lobstertalk_probe_gate.py.

Run:  FASTEMBED_CACHE_PATH=~/.cache/fastembed .venv/bin/python scripts/lobstertalk_compare_gates.py
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("HF_HUB_OFFLINE", "1")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
from lobstertalk_probe_gate import PROBES

from clawbits.lobstertalk.attention.gate import (
    DEFAULT_THRESHOLD,
    NEEDS_ATTENTION,
    NEEDS_ATTENTION_UTTERANCES,
    RESOLVED_SOCIAL,
    RESOLVED_SOCIAL_UTTERANCES,
    _clip_query,
)

# --- frozen v1 baseline: the sets shipped before 2026-07-27 ------------------

V1_NEEDS = [
    "does anyone know how to do this?",
    "how do I get this working?",
    "what's the best way to approach this?",
    "can someone help me with this?",
    "I'm stuck on this and not sure what to try next",
    "any idea why this isn't working?",
    "is it possible to do this?",
    "has anyone run into this before?",
    "we're blocked on this",
    "I've tried everything and it still fails",
    "nobody has gotten back to me on this",
    "should we go with option A or option B?",
    "any objections to this approach?",
    "what do you think about this?",
    "who can help with this?",
]

V1_DECOY = [
    "thanks, that worked!",
    "sounds good to me",
    "will do",
    "nice, appreciate it",
    "never mind, I figured it out",
    "fixed it, it was a typo",
    "here's the answer: you set the flag in config",
    "lol same",
    "good morning everyone",
    "great work team",
    "ok cool",
    "see you tomorrow",
]

BASELINE = "v1/mean"
CURRENT = "current/max"

CONFIGS = {
    BASELINE: (V1_NEEDS, V1_DECOY, "mean"),
    CURRENT: (NEEDS_ATTENTION_UTTERANCES, RESOLVED_SOCIAL_UTTERANCES, "max"),
}

TOP_K = 5


def main() -> None:
    from semantic_router.encoders import FastEmbedEncoder

    encoder = FastEmbedEncoder(score_threshold=DEFAULT_THRESHOLD)

    all_utts = list(dict.fromkeys(u for needs, decoy, _ in CONFIGS.values() for u in [*needs, *decoy]))
    utt_vec = {u: v for u, v in zip(all_utts, encoder(all_utts), strict=True)}
    # Production preprocessing (head+tail clip) applied uniformly, so configs
    # differ only in utterance sets and aggregation.
    probe_texts = [_clip_query(m) for _, _, m in PROBES]
    probe_vec = encoder(probe_texts)

    def norm(v):
        v = np.asarray(v, dtype=np.float64)
        return v / np.linalg.norm(v)

    utt_vec = {u: norm(v) for u, v in utt_vec.items()}
    probe_vec = [norm(v) for v in probe_vec]

    def decide(pv, needs, decoy, agg):
        utts = [(u, NEEDS_ATTENTION) for u in needs] + [(u, RESOLVED_SOCIAL) for u in decoy]
        sims = np.array([float(utt_vec[u] @ pv) for u, _ in utts])
        order = np.argsort(-sims)[:TOP_K]
        by_route: dict[str, list[float]] = {}
        for i in order:
            by_route.setdefault(utts[i][1], []).append(sims[i])
        f = np.mean if agg == "mean" else np.max
        scores = {r: float(f(v)) for r, v in by_route.items()}
        winner = max(scores, key=scores.get)
        if scores[winner] < DEFAULT_THRESHOLD:
            return False, None, scores
        return winner == NEEDS_ATTENTION, winner, scores

    results: dict[str, list[bool]] = {}
    details: dict[str, list[tuple]] = {}
    for name, (needs, decoy, agg) in CONFIGS.items():
        oks, det = [], []
        for pv, (cat, expected, msg) in zip(probe_vec, PROBES, strict=True):
            esc, winner, scores = decide(pv, needs, decoy, agg)
            oks.append(esc == expected)
            det.append((esc == expected, esc, expected, cat, msg, scores))
        results[name] = oks
        details[name] = det

    print(f"probes={len(PROBES)}  top_k={TOP_K}  threshold={DEFAULT_THRESHOLD}")
    for name, (needs, decoy, _) in CONFIGS.items():
        print(f"  {name:14s} {len(needs)} attention / {len(decoy)} decoy utterances")
    print()
    for name, oks in results.items():
        fn = sum(1 for ok, esc, exp, *_ in details[name] if not ok and exp)
        fp = sum(1 for ok, esc, exp, *_ in details[name] if not ok and not exp)
        print(f"  {name:14s} correct {sum(oks):2d}/{len(oks)}  (missed-escalations {fn}, false-nudges {fp})")

    def fmt_scores(scores):
        return " ".join(f"{r.split('_')[0]}:{s:.3f}" for r, s in sorted(scores.items(), key=lambda kv: -kv[1]))

    base = details[BASELINE]
    for name in CONFIGS:
        if name == BASELINE:
            continue
        print(f"\n--- flips {name} vs {BASELINE} ---")
        for (b_ok, *_), (ok, _esc, exp, cat, msg, scores) in zip(base, details[name], strict=True):
            if b_ok == ok:
                continue
            arrow = "FIXED " if ok else "BROKE "
            print(f"  {arrow} [{cat:18s}] want={'ESC' if exp else 'drop'} [{fmt_scores(scores)}] {msg[:64]!r}")

    print(f"\n--- remaining misses on {CURRENT} ---")
    for ok, _esc, exp, cat, msg, scores in details[CURRENT]:
        if ok:
            continue
        print(f"  [{cat:18s}] want={'ESC' if exp else 'drop'} [{fmt_scores(scores)}] {msg[:64]!r}")

    print(f"\n--- decision margins ({CURRENT}) ---")
    tight = sum(
        1
        for ok, esc, exp, cat, msg, scores in details[CURRENT]
        if len(scores) == 2 and abs(scores[NEEDS_ATTENTION] - scores[RESOLVED_SOCIAL]) < 0.02
    )
    print(f"  decisions with both routes in top-5 and margin < 0.02: {tight}/{len(PROBES)}")


if __name__ == "__main__":
    main()
