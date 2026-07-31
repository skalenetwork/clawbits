"""Offline probe of the LobsterTalk attention gate against realistic channel messages.

Runs the REAL gate (same build path as the server — encoder, threshold and
aggregation exactly as gate.py configures them) and reports, per probe:
verdict, winning route+score, and the top-3 nearest utterances so coverage
gaps are visible. Purely local; model already in the FastEmbed cache.

Run:  FASTEMBED_CACHE_PATH=~/.cache/fastembed .venv/bin/python scripts/lobstertalk_probe_gate.py
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("HF_HUB_OFFLINE", "1")
sys.path.insert(0, "/home/i/sk/clawbits")

import numpy as np

from clawbits.lobstertalk.attention.gate import (
    DEFAULT_THRESHOLD,
    AttentionGate,
    _clip_query,
)

# (category, expected_escalate, message)
PROBES = [
    # --- A. paraphrases of listed utterances (sanity: must escalate) ---
    ("A-paraphrase", True, "anyone know how I can get this to work?"),
    ("A-paraphrase", True, "could somebody give me a hand with this?"),
    ("A-paraphrase", True, "I'm stuck, not sure what else to try"),
    ("A-paraphrase", True, "still waiting on an answer here"),
    ("A-paraphrase", True, "which option should we pick, A or B?"),
    # --- B. coverage-gap help forms (should escalate; not in utterance list) ---
    ("B-trouble-report", True, "the deploy has been failing since this morning"),
    ("B-trouble-report", True, "prod is down again"),
    ("B-trouble-report", True, "tests are red on main after the last merge"),
    ("B-trouble-report", True, "the build breaks with a segfault in CI but passes locally"),
    ("B-review-request", True, "can someone review PR #234?"),
    ("B-review-request", True, "please take a look at my branch when you get a chance"),
    ("B-error-paste", True, "getting `ConnectionRefusedError: [Errno 111]` on startup, any ideas?"),
    ("B-error-paste", True, "TypeError: 'NoneType' object is not subscriptable — what am I missing?"),
    ("B-how-to", True, "is there a doc for the signup flow?"),
    ("B-how-to", True, "would appreciate any pointers on setting up the router extra"),
    ("B-how-to", True, "what does this error message actually mean?"),
    ("B-indirect", True, "not sure who owns the billing code but it's double-charging"),
    ("B-indirect", True, "cc @team — any takers for this one?"),
    ("B-decision", True, "we need to decide between Redis and Postgres for cooldowns by Friday"),
    ("B-short", True, "thoughts?"),
    ("B-short", True, "help?"),
    # --- C. should NOT escalate ---
    ("C-ack", False, "thanks so much, that fixed it"),
    ("C-ack", False, "perfect, works now"),
    ("C-ack", False, "got it, thanks!"),
    ("C-ack", False, "+1"),
    ("C-status", False, "deployed to staging, all green"),
    ("C-status", False, "FYI I merged the PR"),
    ("C-status", False, "I'll look into it tomorrow"),
    ("C-status", False, "pushed a fix, waiting for CI"),
    ("C-social", False, "welcome to the team @newuser!"),
    ("C-social", False, "haha nice"),
    ("C-social", False, "standup in 5"),
    ("C-social", False, "happy friday everyone 🎉"),
    ("C-answer", False, "you just set CLAWBITS_ATTENTION_ENABLED=1 and restart the server"),
    ("C-answer", False, "it's in the README under Enabling, second bullet"),
    ("C-answer", False, "that happens because the session is sync — wrap it in to_thread"),
    ("C-link-drop", False, "https://example.com/blog/embeddings — interesting read"),
    # --- D. adversarial / hard cases ---
    ("D-rhetorical", False, "guess what, it finally works!"),
    ("D-social-question", False, "can you believe this weather?"),
    ("D-social-question", False, "who's in for lunch?"),
    ("D-answer-question", False, "does that answer your question?"),
    ("D-gratitude-request", True, "thanks in advance for any help with this"),
    ("D-nevermind", False, "never mind, got it working"),
    ("D-frustration", True, "why does this keep happening 😤"),
    ("D-caps", True, "HELP THE SERVER IS DOWN"),
    ("D-typos", True, "any1 no how 2 fix this??"),
    ("D-emoji", False, "🎉🎉🎉"),
    ("D-past-question", True, "how did you fix it in the end?"),
    # --- E. non-English help requests (bge-small is EN-only; expect misses) ---
    ("E-russian", True, "кто-нибудь знает, как это починить?"),
    ("E-spanish", True, "¿alguien sabe cómo arreglar esto?"),
    ("E-chinese", True, "这个怎么配置？有人知道吗？"),
    ("E-german", True, "weiß jemand, wie man das konfiguriert?"),
]

# Truncation test: same ask, up-front vs buried past the 512-char cut.
FILLER = (
    "Some context first. We migrated the staging environment to the new compose file "
    "yesterday and moved the reverse proxy to the shared network. After that we rotated "
    "the API keys for the three integration agents and re-ran the smoke suite twice. "
    "Everything looked fine until this morning when the scheduled sync started. The sync "
    "job pulls channel history, writes it to the archive bucket, then notifies the "
    "downstream consumers. The first two steps completed normally according to the logs. "
)
ASK = "Does anyone know why the notify step would silently hang with no error?"
PROBES.append(("F-ask-first", True, ASK + " " + FILLER))
PROBES.append(("F-ask-buried", True, FILLER + FILLER[: 512 - len(FILLER) - 10] + " " + ASK))


def main() -> None:
    gate = AttentionGate.build(DEFAULT_THRESHOLD)
    router = gate._router
    index = router.index

    # Aligned utterance metadata + embeddings for neighborhood inspection.
    routes_arr = [str(r) for r in index.routes]
    utt_arr = [str(u) for u in index.utterances]
    emb = np.asarray(index.index, dtype=np.float64)
    emb = emb / np.linalg.norm(emb, axis=1, keepdims=True)

    def neighborhood(text: str, k: int = 5):
        vec = np.asarray(router._encode(text=[_clip_query(text)], input_type="queries"), dtype=np.float64)
        v = vec.reshape(-1)
        v = v / np.linalg.norm(v)
        sims = emb @ v
        order = np.argsort(-sims)[:k]
        return [(float(sims[i]), routes_arr[i], utt_arr[i]) for i in order]

    n_fail = 0
    rows = []
    for cat, expected, msg in PROBES:
        verdict = gate.evaluate(msg)
        ok = verdict.escalate == expected
        n_fail += 0 if ok else 1
        top = neighborhood(msg, 5)
        by_route: dict[str, list[float]] = {}
        for s, r, _ in top:
            by_route.setdefault(r, []).append(s)
        # Mirror the router's aggregation so the displayed per-route figures
        # line up with the official verdict score.
        agg = max if getattr(router, "aggregation", "max") == "max" else (lambda v: sum(v) / len(v))
        means = {r: agg(v) for r, v in by_route.items()}
        rows.append((ok, cat, expected, verdict, means, msg, top))

    print(f"threshold={DEFAULT_THRESHOLD}  model=BAAI/bge-small-en-v1.5  "
          f"aggregation={getattr(router, 'aggregation', '?')}(top5)")
    print(f"{len(PROBES)} probes, {n_fail} misclassified\n")
    for ok, cat, expected, verdict, means, msg, top in rows:
        flag = "  ok " if ok else "MISS "
        want = "ESC" if expected else "drop"
        got = "ESC" if verdict.escalate else "drop"
        mstr = " ".join(
            f"{r.split('_')[0]}:{m:.3f}" for r, m in sorted(means.items(), key=lambda kv: -kv[1])
        )
        preview = msg if len(msg) <= 72 else msg[:69] + "..."
        print(f"{flag}[{cat:18s}] want={want} got={got} route={verdict.route or '-':18s} "
              f"score={verdict.score if verdict.score is not None else 0:.3f} means[{mstr}]")
        print(f"      msg: {preview!r}")
        if not ok:
            for s, r, u in top[:3]:
                print(f"        {s:.3f} {r:>18s} | {u}")
    print("\nMisses by category:")
    misses: dict[str, int] = {}
    totals: dict[str, int] = {}
    for ok, cat, *_ in rows:
        totals[cat] = totals.get(cat, 0) + 1
        if not ok:
            misses[cat] = misses.get(cat, 0) + 1
    for cat in sorted(totals):
        print(f"  {cat:20s} {misses.get(cat, 0)}/{totals[cat]}")


if __name__ == "__main__":
    main()
