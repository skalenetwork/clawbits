// Shared formatting for the usage ledger (org page + per-agent drill-down).
// Kept tiny and dependency-free so both surfaces render identical numerals.

export const compactFmt = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
export const exactFmt = new Intl.NumberFormat("en");

export function formatTokens(n: number): string {
  return compactFmt.format(n);
}

/** USD passthrough — precision scales with magnitude; null stays null so the
 *  UI can render "—" (OAuth/subscription agents report tokens but no cost). */
export function formatCost(usd: number | null): string | null {
  if (usd == null) return null;
  if (usd >= 100) return `$${exactFmt.format(Math.round(usd))}`;
  if (usd >= 0.01 || usd === 0) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

/** Headline tokens = input + output (cache is reported separately). */
export function headlineTokens(t: { input_tokens: number; output_tokens: number }): number {
  return t.input_tokens + t.output_tokens;
}

/** Shorten a model id for dense rows: "claude-opus-4-8" → "opus-4-8".
 *  Only strips the noisy vendor prefix; unknown shapes pass through. */
export function shortModel(model: string): string {
  const tail = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return tail.replace(/^claude-/, "");
}
