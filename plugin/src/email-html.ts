// Minimal HTML→text reduction for email bodies. Many real emails ship only a
// `text/html` part; without this the agent would see "(no text body)" for them.
// This is deliberately small (no DOM, no dependency) — it strips markup, turns
// block-level boundaries into newlines, decodes the common entities, and
// collapses whitespace. Good enough to hand readable prose to the model.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return "";
      }
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      try {
        return String.fromCodePoint(Number(dec));
      } catch {
        return "";
      }
    })
    .replace(/&([a-z]+);/gi, (whole, name: string) => {
      const repl = NAMED_ENTITIES[name.toLowerCase()];
      return repl ?? whole;
    });
}

/** Reduce an HTML document/fragment to readable plain text. */
export function htmlToText(html: string): string {
  if (!html) return "";
  let s = html;
  // Drop non-content blocks wholesale so their bodies don't leak into the text.
  s = s.replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, " ");
  // Comments.
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Line breaks and block boundaries become newlines.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|table|ul|ol|blockquote|section|article)\s*>/gi, "\n");
  // Strip any remaining tags.
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  // Normalize whitespace: unify newlines, trim trailing spaces, cap blank runs.
  s = s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}
