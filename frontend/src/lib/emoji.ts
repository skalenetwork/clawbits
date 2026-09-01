/** Emoji helpers shared by the picker, the :shortcode autocomplete, and
 *  the "jumbo emoji" message renderer. */

// Matches the parts that make up an emoji grapheme: the base pictographic
// codepoint, skin-tone modifiers, regional-indicator flag halves, and the
// ZWJ + variation selector glue used in sequences like "👨‍👩‍👧" or "🏃🏽‍♀️".
const EMOJI_GRAPHEME_RE = /^(\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200D|\uFE0F)+$/u;

/** Returns the number of emoji graphemes in ``text`` when (after trimming)
 *  the body is *only* emojis, ignoring internal whitespace. Returns 0 for
 *  any message containing non-emoji content — that's the signal callers
 *  use to fall back to normal text rendering.
 *
 *  Uses ``Intl.Segmenter`` so ZWJ sequences and skin-tone modifiers count
 *  as a single emoji (matching what the user sees). Bails out at 32 so a
 *  pasted block of 10k emojis doesn't tie up the render thread. */
export function classifyEmojiOnly(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  // Intl.Segmenter is universally available in 2026 browsers, but be
  // defensive — degrading to "not emoji-only" is correct fallback.
  if (typeof Intl === "undefined" || typeof Intl.Segmenter === "undefined") return 0;
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
  let count = 0;
  for (const { segment } of seg.segment(trimmed)) {
    if (/^\s+$/.test(segment)) continue;
    if (!EMOJI_GRAPHEME_RE.test(segment)) return 0;
    count++;
    if (count >= 32) return 32;
  }
  return count;
}

/** Tailwind class for the jumbo-emoji render given a non-zero emoji
 *  count from {@link classifyEmojiOnly}. Sizes track the user's spec:
 *  1=h1-ish, 2=h2-ish, 3=h3-ish, 4+=h4-ish. */
export function jumboEmojiClass(count: number): string {
  if (count <= 1) return "text-5xl leading-tight";
  if (count === 2) return "text-4xl leading-tight";
  if (count === 3) return "text-3xl leading-tight";
  return "text-2xl leading-snug";
}

/** Find a Discord/Slack-style ``:shortcode`` query ending at the caret.
 *  Returns ``null`` when the caret isn't currently inside a colon-prefixed
 *  word; otherwise the start/end of the substring to replace and the
 *  query string (without the leading colon).
 *
 *  Mirrors ``extractMentionQuery`` in ChannelPage.tsx — same anchoring
 *  rules (word-boundary or string start), same character class. Keeping
 *  these as parallel functions rather than a generic abstraction so the
 *  call sites read straightforwardly. */
export function extractShortcodeQuery(
  text: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s):([a-z0-9_+-]*)$/.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  // Require at least one character after the colon — otherwise "Hi: " in
  // the middle of a sentence would constantly open the picker.
  if (query.length === 0) return null;
  const start = before.length - query.length - 1;
  return { start, end: caret, query };
}

const SKIN_TONE_KEY = "fc_emoji_skin_tone";
const VALID_SKIN_TONES = new Set(["none", "light", "medium-light", "medium", "medium-dark", "dark"]);

export type SkinTone = "none" | "light" | "medium-light" | "medium" | "medium-dark" | "dark";

export function loadSkinTone(): SkinTone {
  if (typeof localStorage === "undefined") return "none";
  try {
    const raw = localStorage.getItem(SKIN_TONE_KEY);
    return raw && VALID_SKIN_TONES.has(raw) ? (raw as SkinTone) : "none";
  } catch {
    return "none";
  }
}

export function saveSkinTone(tone: SkinTone): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SKIN_TONE_KEY, tone);
  } catch {
    /* localStorage unavailable — ignore */
  }
}
