/**
 * Pull link-able URLs out of a chat message body.
 *
 * The chat composer accepts free text + markdown, so a message can carry
 * URLs three ways:
 *
 *   1. ``[label](url)`` — markdown link form
 *   2. ``<https://...>`` — explicit autolink
 *   3. Bare ``https://...`` in running text
 *
 * The bubble's markdown renderer already turns all three into tappable
 * blue text. For the OG-card layer, we just need a list of URLs to
 * unfurl — order and dedup preserved.
 *
 * Only ``http(s)`` URLs are returned; ``mailto:``, ``tel:``,
 * ``javascript:`` etc. are intentionally excluded because the server
 * rejects them anyway and a card under a ``mailto:`` link would look
 * odd.
 */

// ASCII printable URL chars, conservatively excluding closing-bracket /
// trailing-punctuation characters that real-world text tends to sit
// next to a URL without being part of it.
const URL_BODY = String.raw`[^\s<>"'\(\)\[\]\{\}]+`;
const URL_RE = new RegExp(String.raw`https?://${URL_BODY}`, 'gi');

// Punctuation that's almost certainly NOT meant to be part of the URL
// when it sits at the very end (``check this out: https://example.com.``
// — the trailing period is the sentence terminator). Stripped after
// extraction.
const TRAILING_JUNK_RE = /[.,;:!?\)\]\}'"]+$/;

/** Extract every ``http(s)://`` URL from the given message body,
 *  deduplicated and in left-to-right order. Trailing sentence
 *  punctuation is stripped so URLs work when pasted at the end of a
 *  sentence. Returns at most {@link MAX_URLS_PER_MESSAGE} URLs — chat
 *  messages with link spam shouldn't trigger a fan-out of unfurls. */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0];
    const cleaned = raw.replace(TRAILING_JUNK_RE, '');
    if (cleaned.length < 'http://a'.length) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= MAX_URLS_PER_MESSAGE) break;
  }
  return out;
}

export const MAX_URLS_PER_MESSAGE = 3;
