import type { CSSProperties } from "react";
import type { WidgetCardRow } from "@/lib/api";
import { cn } from "@/lib/utils";
import { cardLabel, parseCard, type Suit } from "./cardNames";

// Suits drawn on a 24-unit grid, filled, so they read at any card size and never fall back to an emoji font.
const SUIT_PATH: Record<Suit, string> = {
  h: "M12 20.5C12 20.5 3 14.6 3 8.9 3 6.1 5.1 4 7.7 4c1.8 0 3.4 1 4.3 2.6C12.9 5 14.5 4 16.3 4 18.9 4 21 6.1 21 8.9c0 5.7-9 11.6-9 11.6z",
  d: "M12 2.5Q14.6 8.4 19 12 14.6 15.6 12 21.5 9.4 15.6 5 12 9.4 8.4 12 2.5z",
  s: "M12 2.5C12 2.5 3 9.2 3 14c0 2.6 2 4.5 4.5 4.5 1.6 0 3-.8 3.7-2L10 21.5h4l-1.2-5c.7 1.2 2.1 2 3.7 2 2.5 0 4.5-1.9 4.5-4.5 0-4.8-9-11.5-9-11.5z",
  c: "M11 14.5 10 21.5h4l-1-7z",
};

function SuitGlyph({ suit, className }: { suit: Suit; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d={SUIT_PATH[suit]} />
      {suit === "c" && (
        <>
          <circle cx="12" cy="7.3" r="4.2" />
          <circle cx="7.3" cy="13.4" r="4.2" />
          <circle cx="16.7" cy="13.4" r="4.2" />
          <circle cx="12" cy="12" r="2.6" />
        </>
      )}
    </svg>
  );
}

/** One card: face up, face down (`back`), or an empty place (null). A card that changes deals in anew. */
function PlayingCard({ code, lifted, dimmed, style }: {
  code: string | null;
  lifted?: boolean;
  dimmed?: boolean;
  style?: CSSProperties;
}) {
  if (code == null) return <span aria-hidden style={style} className="wgt-playing-card wgt-card-slot" />;
  const card = parseCard(code);
  if (!card) {
    return <span role="img" aria-label={cardLabel(code)} style={style} className="wgt-playing-card wgt-card-back wgt-deal" />;
  }
  const red = card.suit === "h" || card.suit === "d";
  return (
    <span
      role="img"
      aria-label={cardLabel(code)}
      style={style}
      className={cn(
        "wgt-playing-card wgt-card-face wgt-deal relative",
        red ? "text-(--w-suit-red)" : "text-(--w-suit-black)",
        lifted && "wgt-card-lift",
        dimmed && "opacity-55",
      )}
    >
      <span aria-hidden className="absolute top-[6%] left-[9%] flex flex-col items-center leading-none">
        <span className="text-[calc(var(--card-w)*0.28)] font-semibold tracking-tight">{card.rank}</span>
        <SuitGlyph suit={card.suit} className="mt-[6%] size-[calc(var(--card-w)*0.2)]" />
      </span>
      <SuitGlyph suit={card.suit} className="absolute right-[9%] bottom-[7%] size-[calc(var(--card-w)*0.46)]" />
    </span>
  );
}

// Past five cards a row fans out, each card over the last, so a long hand keeps to the width of five.
const FAN_FROM = 5;

function CardRow({ row, edge }: { row: WidgetCardRow; edge: "top" | "middle" | "bottom" }) {
  const lift = row.lift ? new Set(row.lift) : null;
  const n = row.cards.length;
  // Five cards and their four gaps span 5.4 card widths; n fanned cards share what one card leaves of that.
  const fan = n > FAN_FROM ? { marginLeft: `calc(var(--card-w) * ${(4.4 / (n - 1) - 1).toFixed(3)})` } : undefined;
  return (
    <div
      role="group"
      aria-label={row.label}
      aria-current={row.active ? true : undefined}
      // A row's note faces the middle of the table, where bets and the pot sit.
      className={cn("flex items-center gap-1.5", edge === "bottom" ? "flex-col-reverse" : "flex-col")}
    >
      <div className={cn("flex justify-center", !fan && "gap-[calc(var(--card-w)*0.1)]")}>
        {row.cards.map((card, i) => (
          // Keyed by place and card, so a card dealt or turned over is a new one and deals in.
          <PlayingCard
            key={`${String(i)}:${card ?? ""}`}
            code={card}
            lifted={lift?.has(i)}
            dimmed={lift != null && !lift.has(i)}
            style={i > 0 ? fan : undefined}
          />
        ))}
      </div>
      {/* Always laid out, so a bet coming and going never moves the cards. */}
      <span
        aria-hidden={!row.note}
        className={cn(
          "rounded-full px-2.5 py-0.5 text-[0.75rem] leading-snug font-medium tabular-nums",
          // The hand in play takes the highlight, in words as well: its row is the current one.
          row.active ? "bg-(--w-highlight) text-(--w-piece-light-edge)" : "bg-[color-mix(in_oklch,var(--w-on-felt)_15%,transparent)]",
          !row.note && "invisible",
        )}
      >
        {row.note ?? " "}
      </span>
    </div>
  );
}

/** A card table: rows of cards on felt, from the far side of the table to the viewer's own hand. Cards size to
 *  the table's width, five across, so it fits a message, the dock and a phone alike. */
export function CardTable({ rows }: { rows: WidgetCardRow[] }) {
  return (
    <div className="wgt-felt grid gap-[calc(var(--card-w)*0.12)] rounded-(--w-radius-inner) px-3 py-3.5">
      {rows.map((row, i) => (
        <CardRow key={row.id} row={row} edge={i === 0 ? "top" : i === rows.length - 1 ? "bottom" : "middle"} />
      ))}
    </div>
  );
}
