/** Playing-card codes a scene may use: rank then suit (`As`, `Td`, `7c`), or `back` for a card face down. */

export type Suit = "c" | "d" | "h" | "s";

const RANK_NAMES: Record<string, string> = {
  A: "ace", K: "king", Q: "queen", J: "jack", T: "ten",
  "9": "nine", "8": "eight", "7": "seven", "6": "six", "5": "five", "4": "four", "3": "three", "2": "two",
};
const SUIT_NAMES: Record<Suit, string> = { c: "clubs", d: "diamonds", h: "hearts", s: "spades" };

export function parseCard(code: string): { rank: string; suit: Suit } | null {
  const [, rank, suit] = /^([2-9TJQKA])([cdhs])$/.exec(code) ?? [];
  return rank && suit ? { rank: rank === "T" ? "10" : rank, suit: suit as Suit } : null;
}

/** What a screen reader says for a card, e.g. "ten of diamonds". */
export function cardLabel(code: string): string {
  const card = parseCard(code);
  if (!card) return "face-down card";
  return `${RANK_NAMES[card.rank === "10" ? "T" : card.rank] ?? card.rank} of ${SUIT_NAMES[card.suit]}`;
}
