/** Sprite names a scene may use, e.g. `chess.wN`; what they look like is `Sprite`'s business. */

const PIECE_NAMES: Record<string, string> = {
  P: "pawn", N: "knight", B: "bishop", R: "rook", Q: "queen", K: "king",
};

export function parseChessSprite(name: string): { color: "w" | "b"; piece: string } | null {
  const [, color, piece] = /^chess\.([wb])([PNBRQK])$/.exec(name) ?? [];
  return piece && (color === "w" || color === "b") ? { color, piece } : null;
}

/** What a screen reader says for a sprite, e.g. "white knight". */
export function spriteLabel(name: string): string {
  if (name === "notebook.ship") return "ship";
  if (name === "notebook.sunk") return "sunk ship";
  const chess = parseChessSprite(name);
  return chess ? `${chess.color === "w" ? "white" : "black"} ${PIECE_NAMES[chess.piece] ?? "piece"}` : "piece";
}
