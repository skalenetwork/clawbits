// Pure helpers for rendering a *streaming* markdown draft. Kept out of the
// component file so the renderer can stay a components-only module (fast
// refresh) and so these can be unit-tested directly.

export const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const BLOCK_MARKER_RE =
  /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||={2,}\s*$|-{3,}\s*$)/;

/**
 * Split streamed markdown into blank-line-delimited blocks, keeping fenced
 * code (which may itself contain blank lines) whole. The last element is the
 * actively-growing block; everything before it is a stable, complete prefix.
 */
export function splitStreamBlocks(src: string): string[] {
  const lines = src.split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  const flush = () => {
    if (cur.length > 0) {
      blocks.push(cur.join("\n"));
      cur = [];
    }
  };
  for (const line of lines) {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const run = fence[1] ?? "";
      if (!inFence) {
        inFence = true;
        fenceChar = run.charAt(0);
        fenceLen = run.length;
      } else if (run.startsWith(fenceChar) && run.length >= fenceLen) {
        inFence = false;
      }
      cur.push(line);
      continue;
    }
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }
    cur.push(line);
  }
  flush();
  return blocks.length > 0 ? blocks : [src];
}

/** How the actively-growing tail block should be rendered. */
export function classifyTail(block: string): "code" | "structured" | "prose" {
  const lines = block.split("\n");
  const first = lines.find((l) => l.trim() !== "") ?? "";
  if (FENCE_RE.test(first)) return "code";
  if (lines.some((l) => BLOCK_MARKER_RE.test(l))) return "structured";
  return "prose";
}

/** Split an open (unterminated, or just-closed) fenced block into its language
 *  hint and the code body streamed so far. */
export function parseOpenFence(block: string): { lang: string | null; code: string } {
  const lines = block.split("\n");
  const firstLine = lines[0] ?? "";
  const open = FENCE_RE.exec(firstLine);
  const marker = open?.[1] ?? "```";
  const lang = firstLine.slice(firstLine.indexOf(marker) + marker.length).trim();
  let body = lines.slice(1);
  // Drop a closing fence if the block already terminated but hasn't yet been
  // pushed above the tail by a following blank line.
  const last = body[body.length - 1] ?? "";
  if (body.length > 0 && FENCE_RE.test(last)) {
    body = body.slice(0, -1);
  }
  return { lang: lang === "" ? null : lang, code: body.join("\n") };
}

/**
 * Close an unterminated fenced code block left dangling mid-stream. This is the
 * one high-value, zero-risk hardening: an open ``` otherwise swallows the rest
 * of the tail as code and reflows violently when the closer arrives. Partial
 * inline emphasis (a lone `**`) is deliberately left alone — it renders as
 * literal markup for the split second before the block settles, which is
 * harmless, whereas heuristic marker-balancing risks corrupting real text.
 * Scoped to the tail only; finished blocks are complete by construction.
 */
export function hardenIncompleteMarkdown(block: string): string {
  const fenceCount = (block.match(/^\s{0,3}(?:`{3,}|~{3,})/gm) ?? []).length;
  return fenceCount % 2 === 1 ? `${block}\n\`\`\`` : block;
}
