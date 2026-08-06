/**
 * HatchingCard — the pre-signup placeholder in the "Add agent" Launch step:
 * the SAME frame + body geometry as {@link AgentCollectibleCard} (the
 * AddAgentCard sibling pattern), but rendered in a muted monochrome theme with
 * a pulsing egg and a shimmering "Hatching…" name arc, plus an optional live
 * status line rendered ON the card (below the egg). When the real agent signs
 * up, {@link CardFlip} swaps it for the real card.
 *
 * Presentational-only; a fixed sentinel seed keeps the mono theme's shape /
 * pattern draw deterministic so every hatching card looks the same.
 */
import { useId } from "react";
import { gradientVector } from "./theme";
import { cn } from "@/lib/utils";
import { TiltCard } from "./TiltCard";
import { cardThemeFromSeed, type CardTheme } from "./theme";
import { CARD_PATTERNS } from "./patterns";
import { arcTextPath, framePath, roundedRectPath } from "./shapes";
import type { CardSize } from "./AgentCollectibleCard";

const f = (n: number) => n.toFixed(2);


// ── Card geometry (mirrors AgentCollectibleCard so the flip lands flush) ─────
const W = 360;
const H = 520;
const TOP_PAD = 48;
const VBH = H + TOP_PAD;
const FRAME = { x: 12, y: 14, w: 336, h: 492 };
const ORNAMENT = 15;
const BODY = { x: 40, y: 42, w: 280, h: 436, r: 26 };
const BODY_CX = BODY.x + BODY.w / 2;
// The egg sits where the real card's avatar will land (AVATAR.cy = 238,
// r = 78) so the reveal reads as the egg BECOMING the agent.
const EGG = { cx: BODY_CX, cy: 238, r: 78 };
// Arc radius for the "Hatching…" label — a snug wrap just outside the egg.
const LABEL_R = EGG.r + 34;

const SIZE_MAXW: Record<CardSize, string> = {
  sm: "max-w-[220px]",
  md: "max-w-[320px]",
  lg: "max-w-[440px]",
};

/** Muted monochrome theme: the card before it has an identity. Seed only
 *  drives the frame silhouette + texture; the palette is pinned gray. */
function hatchingTheme(seed: string): CardTheme {
  return {
    ...cardThemeFromSeed(seed),
    frame: "#ffffff",
    gradientFrom: "oklch(0.62 0.008 260)",
    gradientTo: "oklch(0.50 0.006 260)",
    ink: "#ffffff",
    pattern: "#ffffff",
    accent: "oklch(0.45 0.01 260)",
  };
}

export interface HatchingCardProps {
  /** Fixed sentinel by default — every hatching card looks the same. */
  seed?: string;
  label?: string;
  tiltMax?: number;
  className?: string;
  size?: CardSize;
}

export function HatchingCard({
  seed = "hatching-agent",
  label = "Hatching",
  tiltMax = 12,
  className,
  size = "md",
}: HatchingCardProps) {
  const uid = useId().replace(/:/g, "");
  const gradId = `${uid}-grad`;
  const bodyClipId = `${uid}-bodyclip`;
  const labelArcId = `${uid}-labelarc`;
  const bgPatId = `${uid}-bgpat`;

  const theme = hatchingTheme(seed);
  const grad = gradientVector(theme.gradientAngle);
  const patternMarkup = CARD_PATTERNS[theme.patternIndex] ?? CARD_PATTERNS[0] ?? "";

  // Egg silhouette: a circle gently stretched upward reads as an egg without
  // bespoke path math (ry > rx, nudged up so the fat end sits low).
  const cardBox = (
    <div className="@container relative w-full">
      <svg
        viewBox={`0 ${String(-TOP_PAD)} ${String(W)} ${String(VBH)}`}
        className="font-rounded block w-full select-none"
        role="img"
        aria-label="Waiting for your agent to hatch"
      >
        <defs>
          <linearGradient id={gradId} x1={grad.x1} y1={grad.y1} x2={grad.x2} y2={grad.y2}>
            <stop offset="0%" stopColor={theme.gradientFrom} />
            <stop offset="100%" stopColor={theme.gradientTo} />
          </linearGradient>
          <pattern
            id={bgPatId}
            width={48}
            height={48}
            patternUnits="userSpaceOnUse"
            patternTransform={`scale(${f(theme.patternScale)})`}
            style={{ color: theme.pattern }}
            dangerouslySetInnerHTML={{ __html: patternMarkup }}
          />
          <clipPath id={bodyClipId}>
            <rect x={BODY.x} y={BODY.y} width={BODY.w} height={BODY.h} rx={BODY.r} />
          </clipPath>
          <path id={labelArcId} d={arcTextPath(EGG.cx, EGG.cy, LABEL_R, 132)} fill="none" />
        </defs>

        {/* Frame + body, in the shared silhouette language. */}
        <path
          d={framePath(theme.shape, FRAME.w, FRAME.h, ORNAMENT)}
          transform={`translate(${String(FRAME.x)} ${String(FRAME.y)})`}
          fill={theme.frame}
        />
        <path d={roundedRectPath(BODY.x, BODY.y, BODY.w, BODY.h, BODY.r)} fill={`url(#${gradId})`} />
        <g clipPath={`url(#${bodyClipId})`} opacity={0.14}>
          <rect x={BODY.x} y={BODY.y} width={BODY.w} height={BODY.h} fill={`url(#${bgPatId})`} />
        </g>

        {/* Big, calm "Hatching…" arc wrapping the egg (where the agent's name
            lands after the flip). The real, changing status lives in the wizard
            button - this stays a constant, shimmering label. */}
        <text className="animate-pulse" fontSize={32} fontWeight={700} letterSpacing={0.5} fill={theme.ink} opacity={0.9}>
          <textPath href={`#${labelArcId}`} startOffset="50%" textAnchor="middle">
            {label}
          </textPath>
        </text>

        {/* The egg: white shell + a soft breathing ring (reduced-motion safe —
            animate-pulse is opacity-only). */}
        <ellipse
          cx={EGG.cx}
          cy={EGG.cy + 4}
          rx={EGG.r * 0.82}
          ry={EGG.r}
          fill="#ffffff"
        />
        <ellipse
          className="animate-pulse"
          cx={EGG.cx}
          cy={EGG.cy + 4}
          rx={EGG.r * 0.82 + 8}
          ry={EGG.r + 8}
          fill="none"
          stroke="#ffffff"
          strokeOpacity={0.5}
          strokeWidth={3}
        />
        {/* Speckles so the shell reads egg, not disc. */}
        <g fill={theme.accent} opacity={0.25}>
          <circle cx={EGG.cx - 22} cy={EGG.cy - 18} r={4} />
          <circle cx={EGG.cx + 18} cy={EGG.cy + 8} r={5} />
          <circle cx={EGG.cx - 6} cy={EGG.cy + 34} r={3.5} />
          <circle cx={EGG.cx + 26} cy={EGG.cy - 30} r={3} />
        </g>
      </svg>
    </div>
  );

  return (
    <TiltCard max={tiltMax} className={cn("w-full", SIZE_MAXW[size], className)}>
      {cardBox}
    </TiltCard>
  );
}
