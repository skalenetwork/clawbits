import type { ReactNode } from "react";
import {
  ArrowUp,
  Ban,
  Check,
  ChevronsUp,
  Clover,
  Equal,
  Flag,
  Hand,
  HandCoins,
  Handshake,
  HeartCrack,
  Layers,
  Plus,
  Shuffle,
  Split,
  Trophy,
  X,
  type LucideProps,
} from "lucide-react";
import type { WidgetEnd } from "@/lib/widgets";

/** The glyph for an action type kinds share; none for others. */
function glyph(type: string, props: LucideProps): ReactNode {
  switch (type) {
    case "offer_draw":
    case "accept_draw":
      return <Handshake {...props} />;
    case "resign":
      return <Flag {...props} />;
    case "decline_draw":
    case "abort":
    case "fold":
      return <X {...props} />;
    case "shuffle":
      return <Shuffle {...props} />;
    case "ready":
    case "check":
      return <Check {...props} />;
    case "call":
      return <Equal {...props} />;
    case "bet":
      return <HandCoins {...props} />;
    case "raise":
      return <ArrowUp {...props} />;
    case "allin":
      // All in on luck.
      return <Clover {...props} />;
    case "deal":
      return <Layers {...props} />;
    case "hit":
      return <Plus {...props} />;
    case "stand":
      return <Hand {...props} />;
    case "double":
      return <ChevronsUp {...props} />;
    case "split":
      return <Split {...props} />;
    default:
      return null;
  }
}

export function ActionGlyph({ type, ...props }: { type: string } & LucideProps) {
  return glyph(type, props);
}

/** What an action's button shows: its glyph and the number its label carries (what a call costs, a bet's size),
 *  or, for an action no glyph names, its label in words. The full label is the button's name. */
export function ActionFace({ type, label, bare = false }: { type: string; label: string; bare?: boolean }) {
  const icon = glyph(type, { "aria-hidden": true, className: "size-[1.125rem] shrink-0" });
  if (!icon) return <span className="px-1 text-[0.875rem] leading-tight font-medium">{label}</span>;
  const number = bare ? undefined : /\d[\d,]*/.exec(label)?.[0];
  return (
    <>
      {icon}
      {number && <span className="text-[0.875rem] leading-none font-semibold tabular-nums">{number}</span>}
    </>
  );
}

/** How a widget ended, the same few glyphs for every kind: a cup for a win, a broken heart of its own for a loss. */
export function EndGlyph({ end, ...props }: { end: WidgetEnd } & LucideProps) {
  switch (end) {
    case "lost":
      return <HeartCrack {...props} />;
    case "draw":
      return <Handshake {...props} />;
    case "ended":
      return <Ban {...props} />;
    default:
      return <Trophy {...props} />;
  }
}
