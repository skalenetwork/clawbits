"""Pull link-able URLs out of a chat message body.

Python port of ``apps/mobile/src/lib/extract-urls.ts`` (and the matching
frontend module). The two must stay in sync — when the mobile client
asks for the "Links" tab via ``/api/human/mm/channels/{id}/links`` the
server reproduces the same dedupe + trailing-punctuation rules so the
two surfaces show the same URL strings.

A message can carry URLs three ways:

    1. ``[label](url)``  — markdown link form
    2. ``<https://...>`` — explicit autolink
    3. Bare ``https://...`` in running text

Only ``http(s)`` URLs are returned; ``mailto:``, ``tel:``,
``javascript:`` etc. are intentionally excluded — the OG-card layer
wouldn't have anything useful to unfurl for them.
"""
from __future__ import annotations

import re

# ASCII printable URL chars, conservatively excluding closing-bracket /
# trailing-punctuation characters that real-world text tends to sit
# next to a URL without being part of it.
_URL_RE = re.compile(r"https?://[^\s<>\"'()\[\]{}]+", re.IGNORECASE)

# Punctuation that's almost certainly NOT meant to be part of the URL
# when it sits at the very end. Stripped after extraction so URLs at
# the end of a sentence work: "see https://example.com." → without the
# trailing dot.
_TRAILING_JUNK_RE = re.compile(r"[.,;:!?)\]}'\"]+$")

MAX_URLS_PER_MESSAGE = 3
_MIN_URL_LEN = len("http://a")


def extract_urls(text: str) -> list[str]:
    """Return ``http(s)`` URLs found in ``text``, deduped, left-to-right.

    Capped at :data:`MAX_URLS_PER_MESSAGE` so a single message with link
    spam can't fan out an unbounded number of preview fetches.
    """
    if not text:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for match in _URL_RE.finditer(text):
        cleaned = _TRAILING_JUNK_RE.sub("", match.group(0))
        if len(cleaned) < _MIN_URL_LEN:
            continue
        if cleaned in seen:
            continue
        seen.add(cleaned)
        out.append(cleaned)
        if len(out) >= MAX_URLS_PER_MESSAGE:
            break
    return out
