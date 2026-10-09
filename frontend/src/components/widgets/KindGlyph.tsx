import { ChessPawn, Club, Gamepad2, Ship, Spade, type LucideProps } from "lucide-react";

/** The glyph that names a widget kind wherever it shows; a kind this client doesn't know gets a generic one. */
export function KindGlyph({ kind, ...props }: { kind: string } & LucideProps) {
  if (kind === "chess") return <ChessPawn {...props} />;
  if (kind === "battleship") return <Ship {...props} />;
  if (kind === "poker") return <Spade {...props} />;
  if (kind === "blackjack") return <Club {...props} />;
  return <Gamepad2 {...props} />;
}
