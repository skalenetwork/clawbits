/**
 * AddAgentCard — a call-to-action "collectible card" that closes the agent
 * binder: the SAME frame + gradient body + seeded texture + radar rings as
 * {@link AgentCollectibleCard}, but the avatar spot is a big white disc with a
 * plus glyph and the curved name reads "Add new agent". It shares that card's
 * geometry + theme system on purpose, so it reads as a true sibling of the real
 * cards rather than a bolted-on tile.
 *
 * Presentational-only: it draws the visual (and owns the 3D hover tilt + glare);
 * the page wraps it in the actual `<button>` that opens the create-agent dialog.
 */
import { useId } from "react";
import { gradientVector } from "./theme";
import { cn } from "@/lib/utils";
import { TiltCard } from "./TiltCard";
import { cardThemeFromSeed, type CardTheme } from "./theme";
import { CARD_PATTERNS } from "./patterns";
import { arcTextPath, framePath, roundedRectPath } from "./shapes";
import type { CardSize } from "./AgentCollectibleCard";

type SvgVarStyle = React.CSSProperties & { cx?: string; cy?: string };
type GlowStyle = React.CSSProperties & { "--card-glow"?: string; "--card-glow2"?: string };

const f = (n: number) => n.toFixed(2);

/** Gradient angle (deg) → objectBoundingBox linear-gradient endpoints. Kept in
 *  sync with AgentCollectibleCard's copy. */

// ── Card geometry (mirrors AgentCollectibleCard so the CTA sits flush) ───────
const W = 360;
const H = 520;
const TOP_PAD = 48;
const VBH = H + TOP_PAD;
const FRAME = { x: 12, y: 14, w: 336, h: 492 };
const ORNAMENT = 15;
const BODY = { x: 40, y: 42, w: 280, h: 436, r: 26 };
const BODY_CX = BODY.x + BODY.w / 2;
const BODY_CY = BODY.y + BODY.h / 2;
// The "add" disc, centered in the body. Its radius matches the real card's white
// avatar ring (AVATAR.r + 6 = 84), so the CTA disc reads as avatar-sized.
const DISC = { cx: BODY_CX, cy: BODY_CY + 6, r: 84 };
const LABEL_R = DISC.r + 34; // "Add new agent" arcs just above the disc

const SIZE_MAXW: Record<CardSize, string> = {
  sm: "max-w-[220px]",
  md: "max-w-[320px]",
  lg: "max-w-[440px]",
};

export interface AddAgentCardProps {
  /** Theme seed — fixed by default so the CTA card looks the same everywhere. */
  seed?: string;
  /** Curved label over the disc. */
  label?: string;
  themeOverrides?: Partial<CardTheme>;
  tiltMax?: number;
  className?: string;
  size?: CardSize;
}

export function AddAgentCard({
  seed = "add-new-agent",
  label = "Add new agent",
  themeOverrides,
  tiltMax = 12,
  className,
  size = "lg",
}: AddAgentCardProps) {
  const uid = useId().replace(/:/g, "");
  const gradId = `${uid}-grad`;
  const bodyClipId = `${uid}-bodyclip`;
  const frameClipId = `${uid}-frameclip`;
  const glareId = `${uid}-glare`;
  const bgPatId = `${uid}-bgpat`;
  const labelArcId = `${uid}-labelarc`;

  const theme: CardTheme = { ...cardThemeFromSeed(seed), ...themeOverrides };
  const grad = gradientVector(theme.gradientAngle);
  const patternMarkup = CARD_PATTERNS[theme.patternIndex] ?? CARD_PATTERNS[0] ?? "";

  const glareStyle: SvgVarStyle = { cx: "var(--tilt-gx, 50%)", cy: "var(--tilt-gy, 50%)" };
  const glowStyle: GlowStyle = { "--card-glow": theme.gradientFrom, "--card-glow2": theme.gradientTo };

  // Plus glyph — two rounded bars in the accent colour, centered in the disc.
  const plus = { len: DISC.r * 0.86, thick: 15 };

  const cardBox = (
    <div className="@container relative w-full">
      <svg
        viewBox={`0 ${String(-TOP_PAD)} ${String(W)} ${String(VBH)}`}
        className="agentcard-shadow font-rounded block w-full select-none"
        style={glowStyle}
        role="img"
        aria-label={label}
      >
        <defs>
          <linearGradient id={gradId} x1={grad.x1} y1={grad.y1} x2={grad.x2} y2={grad.y2}>
            <stop offset="0%" stopColor={theme.gradientFrom} />
            <stop offset="100%" stopColor={theme.gradientTo} />
          </linearGradient>
          <radialGradient id={glareId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={0.9} />
            <stop offset="42%" stopColor="#ffffff" stopOpacity={0.18} />
            <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
          </radialGradient>
          {/* Seeded tiling background texture (paints in currentColor). */}
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
          <clipPath id={frameClipId}>
            <path
              d={framePath(theme.shape, FRAME.w, FRAME.h, ORNAMENT)}
              transform={`translate(${String(FRAME.x)} ${String(FRAME.y)})`}
            />
          </clipPath>
          <path id={labelArcId} d={arcTextPath(DISC.cx, DISC.cy, LABEL_R, 132)} fill="none" />
        </defs>

        {/* ── Frame ("matte") ── */}
        <path
          d={framePath(theme.shape, FRAME.w, FRAME.h, ORNAMENT)}
          transform={`translate(${String(FRAME.x)} ${String(FRAME.y)})`}
          fill={theme.frame}
        />

        {/* ── Body (gradient) ── */}
        <path d={roundedRectPath(BODY.x, BODY.y, BODY.w, BODY.h, BODY.r)} fill={`url(#${gradId})`} />

        {/* ── Seeded background texture, clipped to the body ── */}
        <g clipPath={`url(#${bodyClipId})`} opacity={0.16}>
          <rect x={BODY.x} y={BODY.y} width={BODY.w} height={BODY.h} fill={`url(#${bgPatId})`} />
        </g>

        {/* ── Radar rings + crosshair, over the texture (clipped to the body) ── */}
        <g clipPath={`url(#${bodyClipId})`} stroke={theme.pattern} strokeWidth={1} fill="none" opacity={0.11}>
          {[52, 100, 148, 196].map((r) => (
            <circle key={r} cx={BODY_CX} cy={BODY_CY} r={r} />
          ))}
          <line x1={BODY_CX} y1={BODY.y} x2={BODY_CX} y2={BODY.y + BODY.h} />
          <line x1={BODY.x} y1={BODY_CY} x2={BODY.x + BODY.w} y2={BODY_CY} />
        </g>

        {/* ── "Add new agent" curved over the disc ── */}
        <text fontSize={23} fontWeight={700} letterSpacing={0.4} fill={theme.ink}>
          <textPath href={`#${labelArcId}`} startOffset="50%" textAnchor="middle">
            {label}
          </textPath>
        </text>

        {/* ── Big "add" disc: white, with a thin accent ring and a bold plus ── */}
        <circle cx={DISC.cx} cy={DISC.cy} r={DISC.r} fill="#ffffff" />
        <circle
          cx={DISC.cx}
          cy={DISC.cy}
          r={DISC.r - 1}
          fill="none"
          stroke={theme.accent}
          strokeOpacity={0.22}
          strokeWidth={2}
        />
        <g fill={theme.accent}>
          <rect
            x={DISC.cx - plus.thick / 2}
            y={DISC.cy - plus.len / 2}
            width={plus.thick}
            height={plus.len}
            rx={plus.thick / 2}
          />
          <rect
            x={DISC.cx - plus.len / 2}
            y={DISC.cy - plus.thick / 2}
            width={plus.len}
            height={plus.thick}
            rx={plus.thick / 2}
          />
        </g>

        {/* ── Specular glare (clipped to the frame silhouette) ── */}
        <g className="agentcard-glare" clipPath={`url(#${frameClipId})`} aria-hidden="true">
          <circle r={170} fill={`url(#${glareId})`} style={glareStyle} />
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
