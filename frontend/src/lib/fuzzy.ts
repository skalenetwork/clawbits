const WORD_SPLIT = /[\s\-_/.@#]+/;

function subsequenceScore(q: string, t: string): number {
  let ti = 0;
  let runs = 0;
  let inRun = false;
  for (const ch of q) {
    let found = false;
    while (ti < t.length) {
      if (t[ti++] === ch) {
        if (!inRun) runs++;
        inRun = true;
        found = true;
        break;
      }
      inRun = false;
    }
    if (!found) return -1;
  }
  return Math.max(0, q.length - (runs - 1) * 2);
}

function scoreToken(q: string, t: string): number {
  if (!q) return 0;
  if (t === q) return 1000;
  const idx = t.indexOf(q);
  if (idx === 0) return 900 - t.length * 0.1;
  if (idx > 0) return (WORD_SPLIT.test(t[idx - 1] ?? "") ? 800 : 500) - idx - t.length * 0.1;
  const initials = t.split(WORD_SPLIT).map((w) => w[0] ?? "").join("");
  if (initials.includes(q)) return 600 - t.length * 0.1;
  const sub = subsequenceScore(q, t);
  return sub < 0 ? -1 : 300 + sub - t.length * 0.1;
}

// Both arguments must already be lowercase, so candidates are lowered once rather than per keystroke.
function fuzzyScore(q: string, t: string): number {
  const tokens = q.split(WORD_SPLIT).filter(Boolean);
  if (tokens.length <= 1) return scoreToken(q, t);
  let total = 0;
  for (const token of tokens) {
    const s = scoreToken(token, t);
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

export function fuzzyScoreAny(q: string, texts: string[]): number {
  return Math.max(-1, ...texts.map((t) => fuzzyScore(q, t)));
}
