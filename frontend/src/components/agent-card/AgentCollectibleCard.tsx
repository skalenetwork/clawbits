/**
 * AgentCollectibleCard — a layered, themeable "collectible card" for an agent.
 *
 * Layout:
 *   - ornamental frame (scalloped / perforated) + gradient body + radar pattern
 *   - name + @handle, gently CURVED to echo the avatar circle below (handle
 *     copies on click)
 *   - the agent's rounded avatar, centered
 *   - an operator "seal" (operator avatar + "Operated by X" around the lower
 *     outline), bottom-right, overlapping the avatar
 *   - minimal frosted-glass stickers (Joined / Runs on Reef / Email) scattered
 *     near the bottom, each with a big cropped tinted icon; the email sticker
 *     shows the address and copies on click
 *   - a cursor-tracked specular glare CLIPPED TO THE FRAME SILHOUETTE
 * Wrapped in a 3D hover tilt.
 *
 * The frame/body/text/avatar are ONE <svg> (scales crisply, text rides shapes);
 * the stickers are an HTML overlay so they can use a real backdrop blur.
 */
import { useId, type ReactNode } from "react";
import { gradientVector } from "./theme";
import { Mail01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { agentStatusLabel } from "@/lib/agentLiveness";
import type { AgentLivenessStatus } from "@/lib/api";
import { Icon } from "@/components/Icon";
import { TiltCard } from "./TiltCard";
import { OperatorSeal } from "./OperatorSeal";
import { JoinedSeal } from "./JoinedSeal";
import { GlassSticker } from "./Sticker";
import { ClawbitsGlyph, ReefCoralGlyph } from "./StickerIcons";
import { cardThemeFromSeed, type CardTheme } from "./theme";
import { CARD_PATTERNS } from "./patterns";
import { useAvatarBaseColor } from "./useAvatarBaseColor";
import { useResilientImage } from "./useResilientImage";
import { arcTextPath, framePath, roundedRectPath } from "./shapes";

// Lets the glare disc read the cursor CSS vars as geometry.
type SvgVarStyle = React.CSSProperties & { cx?: string; cy?: string };
// Card-gradient colors fed to the colored drop shadow (see .agentcard-shadow).
type GlowStyle = React.CSSProperties & { "--card-glow"?: string; "--card-glow2"?: string };

const f = (n: number) => n.toFixed(2);

/** Convert a gradient angle (deg, 0 = top→bottom, + = clockwise) into
 *  objectBoundingBox linear-gradient endpoints. */

// ── Card geometry (local SVG user space) ────────────────────────────────────
const W = 360;
const H = 520;
// Extra headroom ABOVE the frame so the JoinedSeal can protrude past the top
// edge. The viewBox is shifted up by this, so the card's aspect ratio is
// W / (H + TOP_PAD) — kept in sync with the page/gallery wrappers.
const TOP_PAD = 48;
const VBH = H + TOP_PAD;
const FRAME = { x: 12, y: 14, w: 336, h: 492 };
const ORNAMENT = 15;
const BODY = { x: 40, y: 42, w: 280, h: 436, r: 26 };
const BODY_CX = BODY.x + BODY.w / 2;
const BODY_CY = BODY.y + BODY.h / 2;
const AVATAR = { cx: BODY_CX, cy: 238, r: 78 };
const NAME_R = AVATAR.cy - 102; // name/handle arcs are concentric with the avatar
const HANDLE_R = AVATAR.cy - 126; // (smaller radius = the curved text sits lower)
const OP_SEAL = { cx: 244, cy: 300 };
// Liveness dot riding the avatar's lower-LEFT edge (the lower-right is the
// operator seal's spot). The white halo mirrors the HTML PresenceDot's ring so
// it reads as a cut-out; proportions follow the avatar's own white ring.
const PRESENCE_OFFSET = (AVATAR.r + 2) * Math.SQRT1_2;
const PRESENCE = {
  cx: AVATAR.cx - PRESENCE_OFFSET,
  cy: AVATAR.cy + PRESENCE_OFFSET,
  r: 13,
  halo: 19,
};
// Same palette as PresenceDot (emerald/blue/zinc). The card is its own
// theme-independent world (white frame + ring in both app themes), so a single
// offline gray is enough.
const STATUS_COLOR: Record<AgentLivenessStatus, string> = {
  available: "#10b981",
  setup: "#3b82f6",
  offline: "#a1a1aa",
};
// "JOINED" medal straddling the top edge (protrudes into the headroom above).
const JOINED_SEAL = { cx: W / 2, cy: 20, r: 42 };

/** Near-black frame ⇒ the rare "premium" card: the JOINED medal inverts to a
 *  dark disc + white ink so it belongs to the dark card. */
function isDarkFrame(hex: string): boolean {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(h)) return false;
  const n = parseInt(h, 16);
  return 0.2126 * ((n >> 16) & 0xff) + 0.7152 * ((n >> 8) & 0xff) + 0.0722 * (n & 0xff) < 96;
}
// Description sticker: bottom-anchored with EQUAL margins on the sides + bottom
// (viewBox units → %), so it hugs the lower body evenly.
const DESC_MARGIN = 13;
const DESC_INSET_PCT = ((BODY.x + DESC_MARGIN) / W) * 100; // left & right
const DESC_BOTTOM_PCT = ((H - (BODY.y + BODY.h - DESC_MARGIN)) / VBH) * 100;
// Single-line chips (Reef / email) ride one centered rail near the body's foot.
const RAIL_BOTTOM_PCT = ((H - (BODY.y + BODY.h - 14)) / VBH) * 100;

interface OperatorInfo {
  name: string;
  avatarUrl?: string | null;
}

/** A placed sticker. Single-line pills flow in a centered rail near the foot and
 *  auto-size to their text; the multiline description is bottom-anchored with
 *  equal margins. */
interface Placed {
  key: string;
  icon?: ReactNode;
  text: string;
  textColor: string;
  multiline?: boolean;
  onClick?: () => void;
  title?: string;
}

export interface AgentCollectibleCardProps {
  seed: string;
  name: string;
  handle: string;
  joined?: string | null;
  avatarUrl?: string | null;
  operator?: OperatorInfo | null;
  email?: string | null;
  /** Short bio/description — shown as a snippet sticker on the grid variant. */
  description?: string | null;
  /** Live agent status — renders a presence dot on the avatar's edge (with a
   *  pulsing "setup" state). Omit/null → no dot (status unknown at the call
   *  site). Derive it via ``useAgentStatus`` so it ticks offline on its own. */
  status?: AgentLivenessStatus | null;
  runsOnReef?: boolean;
  /** Click handler for the "Runs on Reef" sticker (e.g. open reef settings). */
  onReefClick?: () => void;
  /** Runtime kind ("openclaw" | "ironclaw") self-reported by the agent's plugin.
   *  Renders a small logo sticker (logo only, no background) in the top-left
   *  corner. Omit/unknown → no sticker. */
  agentType?: string | null;
  /** Clawbits plugin version self-reported by the agent's plugin. Renders a
   *  small "clawbits vX.Y.Z" pill (top-right corner). Omit → no sticker. */
  pluginVersion?: string | null;
  themeOverrides?: Partial<CardTheme>;
  tiltMax?: number;
  className?: string;
  /** Preset max width. The card scales its contents to fit (cqw), so any size
   *  reads correctly from thumbnail to hero. Default "lg". */
  size?: CardSize;
  /** Display-only: disables click-to-copy / Reef nav (so a parent link owns the
   *  clicks). By default it also drops the 3D tilt — pass `tilt` to keep it. */
  presentational?: boolean;
  /** Force the 3D pointer tilt regardless of `presentational` (e.g. the gallery
   *  wants the tilt but non-interactive stickers). Defaults to `!presentational`. */
  tilt?: boolean;
  /** "grid" (gallery) enlarges the operator seal + Joined sticker and drops the
   *  Reef sticker; "full" (detail page) keeps every sticker. Default "full". */
  variant?: CardVariant;
}

function formatJoined(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getDate();
  const month = d.toLocaleDateString(undefined, { month: "short" });
  return `${String(day)} ${month} ${String(d.getFullYear())}`;
}

function nameFontSize(name: string): number {
  const n = name.length;
  if (n <= 8) return 34;
  if (n <= 12) return 27;
  if (n <= 16) return 21;
  return 18;
}

function copyToClipboard(text: string, label: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => { toast.success(`${label} copied`); })
    .catch(() => { toast.error(`Couldn't copy ${label.toLowerCase()}`); });
}

const ICON_CLS = "h-full w-auto block";

// Runtime-kind → logo asset (served from `frontend/public`). The type sticker is
// just this logo (no background); unknown kinds render nothing. A `tint` marks
// a monochrome silhouette that must be mask-rendered in a controlled ink (an
// <img> can't be recoloured). Constant near-black, not a theme token: the card
// art is seed-keyed and doesn't flip with the UI theme.
const TYPE_LOGO: Record<string, { src: string; alt: string; tint?: string }> = {
  openclaw: { src: "/openclaw.png", alt: "OpenClaw" },
  ironclaw: { src: "/ironclaw.webp", alt: "IronClaw" },
  hermes: { src: "/hermes.svg", alt: "Hermes", tint: "#111111" },
};

// Top-left "spec" sticker (the runtime-kind logo), in the card's full-viewBox
// overlay (which starts at −TOP_PAD). Placed clear of the centered JOINED medal
// and the curved name below. The plugin version now rides the foot rail instead.
const SPEC_TOP_PCT = ((82 + TOP_PAD) / VBH) * 100; // the type-logo row
const TYPE_LEFT_PCT = (90 / W) * 100; // type logo — centered here (inset off the edge)

export type CardSize = "sm" | "md" | "lg";
const SIZE_MAXW: Record<CardSize, string> = {
  sm: "max-w-[220px]",
  md: "max-w-[320px]",
  lg: "max-w-[440px]",
};

/** "grid" = gallery treatment (bigger operator seal + Joined sticker, no Reef
 *  sticker); "full" = the detail-page card. */
export type CardVariant = "full" | "grid";

export function AgentCollectibleCard({
  seed,
  name,
  handle,
  joined,
  avatarUrl,
  operator,
  email,
  description,
  status,
  runsOnReef = false,
  onReefClick,
  agentType,
  pluginVersion,
  themeOverrides,
  tiltMax = 12,
  className,
  size = "lg",
  presentational = false,
  tilt,
  variant = "full",
}: AgentCollectibleCardProps) {
  const interactive = !presentational;
  const useTilt = tilt ?? !presentational;
  const grid = variant === "grid";
  const uid = useId().replace(/:/g, "");
  const gradId = `${uid}-grad`;
  const bodyClipId = `${uid}-bodyclip`;
  const frameClipId = `${uid}-frameclip`;
  const glareId = `${uid}-glare`;
  const bgPatId = `${uid}-bgpat`;
  const avatarClipId = `${uid}-avatarclip`;
  const nameArcId = `${uid}-namearc`;
  const handleArcId = `${uid}-handlearc`;

  // Anchor the body colour to the agent's own avatar when we can read it
  // (async, cached) — else the theme uses its seed-derived hue.
  const avatarColor = useAvatarBaseColor(avatarUrl);
  // Only paint the avatar once the SVG actually loads — a just-signed-up
  // agent's row is visible before its avatar lands in R2, and a raw SVG
  // <image> would render the OS broken-image glyph for that 404. Until it
  // resolves (or after it gives up) we fall through to the letter below.
  const resolvedAvatarUrl = useResilientImage(avatarUrl);
  const theme: CardTheme = { ...cardThemeFromSeed(seed, avatarColor ?? undefined), ...themeOverrides };
  const sealDark = isDarkFrame(theme.frame);
  const grad = gradientVector(theme.gradientAngle);
  const patternMarkup = CARD_PATTERNS[theme.patternIndex] ?? CARD_PATTERNS[0] ?? "";
  const joinedLabel = formatJoined(joined);
  const avatarFallback = (name.trim().charAt(0) || "?").toUpperCase();

  // Self-reported "spec" stickers (top corners): the runtime-kind logo and the
  // Clawbits plugin version. Both are absent until the agent's plugin has
  // reported them, so each renders only when known.
  const typeLogo = agentType ? TYPE_LOGO[agentType.toLowerCase()] : undefined;
  const versionLabel = pluginVersion ? `v${pluginVersion.replace(/^v/i, "")}` : null;

  const emailDisplay = email && email.length > 34 ? `${email.slice(0, 31)}…` : email;
  // Longer snippet — the grid description sticker is bigger now (3 lines).
  const descSnippet = description?.trim().replace(/\s+/g, " ").slice(0, 140) ?? "";

  // Chips near the foot of the card. Single-line pills (Reef / email) align on one
  // centered rail; the "grid" (gallery) variant shows a description snippet instead.
  const stickers: Placed[] = [];
  if (grid) {
    if (descSnippet)
      stickers.push({
        key: "desc", text: descSnippet, textColor: theme.accent, multiline: true,
      });
  } else {
    if (runsOnReef)
      stickers.push({
        key: "reef",
        icon: <ReefCoralGlyph color={theme.accent} className={ICON_CLS} />,
        text: "Reef", textColor: theme.accent,
        onClick: interactive ? onReefClick : undefined,
        title: interactive ? "Runs on Reef — open Reef settings" : undefined,
      });
    // Plugin version — a frosted rail chip next to Reef (full variant only, so
    // the smaller "grid" card doesn't carry it). Informational, so no onClick.
    if (versionLabel)
      stickers.push({
        key: "version",
        icon: <ClawbitsGlyph color={theme.accent} className={ICON_CLS} />,
        text: versionLabel, textColor: theme.accent,
        title: `Clawbits plugin ${versionLabel}`,
      });
    if (email && emailDisplay)
      stickers.push({
        key: "email",
        icon: <Icon icon={Mail01Icon} className="size-full" />,
        text: emailDisplay, textColor: theme.accent,
        onClick: interactive ? () => { copyToClipboard(email, "Email"); } : undefined,
        title: interactive ? `${email} — click to copy` : undefined,
      });
  }
  const descSticker = stickers.find((s) => s.multiline);
  const railChips = stickers.filter((s) => !s.multiline);

  const glareStyle: SvgVarStyle = { cx: "var(--tilt-gx, 50%)", cy: "var(--tilt-gy, 50%)" };
  // Feed the card's gradient to the colored drop shadow.
  const glowStyle: GlowStyle = { "--card-glow": theme.gradientFrom, "--card-glow2": theme.gradientTo };

  const cardBox = (
    <div className="@container relative w-full">
      <svg
          viewBox={`0 ${String(-TOP_PAD)} ${String(W)} ${String(VBH)}`}
          className="agentcard-shadow font-rounded block w-full select-none"
          style={glowStyle}
          role="img"
          aria-label={`${name} — agent card`}
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
            {/* Seeded tiling background texture. The pattern markup paints in
                `currentColor`, so the `color` here tints it. */}
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
            <clipPath id={avatarClipId}>
              <circle cx={AVATAR.cx} cy={AVATAR.cy} r={AVATAR.r} />
            </clipPath>
            <clipPath id={frameClipId}>
              <path
                d={framePath(theme.shape, FRAME.w, FRAME.h, ORNAMENT)}
                transform={`translate(${String(FRAME.x)} ${String(FRAME.y)})`}
              />
            </clipPath>
            <path id={nameArcId} d={arcTextPath(AVATAR.cx, AVATAR.cy, NAME_R, 150)} fill="none" />
            <path id={handleArcId} d={arcTextPath(AVATAR.cx, AVATAR.cy, HANDLE_R, 132)} fill="none" />
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

          {/* ── Name (curved) ── */}
          <text fontSize={nameFontSize(name)} fontWeight={700} fill={theme.ink}>
            <textPath href={`#${nameArcId}`} startOffset="50%" textAnchor="middle">
              {name}
            </textPath>
          </text>

          {/* ── Handle (curved, click to copy) ── */}
          <text
            fontSize={13}
            fontWeight={600}
            letterSpacing={0.5}
            fill={theme.ink}
            opacity={0.9}
            style={interactive ? { cursor: "pointer" } : undefined}
            onClick={interactive ? () => { copyToClipboard(`@${handle}`, "Handle"); } : undefined}
          >
            <textPath href={`#${handleArcId}`} startOffset="50%" textAnchor="middle">
              {`@${handle}`}
            </textPath>
            {interactive && <title>Click to copy handle</title>}
          </text>

          {/* ── Medallion: a thin containment ring + registration ticks, so the
              avatar reads "mounted" rather than floating in the body. ── */}
          <circle
            cx={AVATAR.cx}
            cy={AVATAR.cy}
            r={AVATAR.r + 14}
            fill="none"
            stroke="#ffffff"
            strokeOpacity={0.5}
            strokeWidth={1.5}
          />
          {Array.from({ length: 12 }, (_, i) => {
            const a = (i / 12) * Math.PI * 2;
            const r1 = AVATAR.r + 10;
            const r2 = AVATAR.r + 17;
            return (
              <line
                key={i}
                x1={AVATAR.cx + Math.cos(a) * r1}
                y1={AVATAR.cy + Math.sin(a) * r1}
                x2={AVATAR.cx + Math.cos(a) * r2}
                y2={AVATAR.cy + Math.sin(a) * r2}
                stroke="#ffffff"
                strokeOpacity={0.4}
                strokeWidth={1.5}
              />
            );
          })}

          {/* ── Center avatar: a solid white ring (a bit larger than the avatar)
              behind the image. No glow/gradient ring. ── */}
          <circle cx={AVATAR.cx} cy={AVATAR.cy} r={AVATAR.r + 6} fill="#ffffff" />
          {resolvedAvatarUrl ? (
            <image
              href={resolvedAvatarUrl}
              x={AVATAR.cx - AVATAR.r}
              y={AVATAR.cy - AVATAR.r}
              width={AVATAR.r * 2}
              height={AVATAR.r * 2}
              clipPath={`url(#${avatarClipId})`}
              preserveAspectRatio="xMidYMid slice"
            />
          ) : (
            <text
              x={AVATAR.cx}
              y={AVATAR.cy + AVATAR.r * 0.34}
              textAnchor="middle"
              fontSize={AVATAR.r}
              fontWeight={700}
              fill={theme.accent}
            >
              {avatarFallback}
            </text>
          )}

          {/* ── Liveness dot (bottom-left of the avatar, cut-out halo) ── */}
          {status && (
            <g role="img" aria-label={`Status: ${agentStatusLabel(status)}`}>
              <title>{agentStatusLabel(status)}</title>
              <circle cx={PRESENCE.cx} cy={PRESENCE.cy} r={PRESENCE.halo} fill="#ffffff" />
              <circle
                cx={PRESENCE.cx}
                cy={PRESENCE.cy}
                r={PRESENCE.r}
                fill={STATUS_COLOR[status]}
                className={status === "setup" ? "animate-pulse" : undefined}
              />
            </g>
          )}

          {/* ── Operator seal (bottom-right, over the avatar) ── */}
          {operator && (
            <OperatorSeal
              cx={OP_SEAL.cx}
              cy={OP_SEAL.cy}
              name={operator.name}
              avatarUrl={operator.avatarUrl}
              avatarRadius={grid ? 26 : 20}
              accent={theme.accent}
            />
          )}

          {/* ── Specular glare (clipped to the frame silhouette) ── */}
          <g className="agentcard-glare" clipPath={`url(#${frameClipId})`} aria-hidden="true">
            <circle r={170} fill={`url(#${glareId})`} style={glareStyle} />
          </g>

          {/* ── "JOINED" medal straddling the top edge (drawn last = on top) ── */}
          {joinedLabel && (
            <JoinedSeal
              cx={JOINED_SEAL.cx}
              cy={JOINED_SEAL.cy}
              r={JOINED_SEAL.r}
              label="JOINED"
              value={joinedLabel}
              disc={theme.frame}
              accent={sealDark ? "#ffffff" : theme.accent}
            />
          )}
        </svg>

        {/* ── Frosted-glass stickers (HTML overlay, for a real backdrop blur) ── */}
        <div className="pointer-events-none absolute inset-0">
          {/* Top-left: runtime-kind logo (logo only, no background). */}
          {typeLogo && (typeLogo.tint ? (
            <span
              role="img"
              aria-label={`${typeLogo.alt} agent`}
              className="absolute block h-[13cqw] w-[13cqw] drop-shadow-[0_1.5px_3px_rgba(0,0,0,0.4)]"
              style={{
                left: `${f(TYPE_LEFT_PCT)}%`,
                top: `${f(SPEC_TOP_PCT)}%`,
                transform: "translate(-50%, -50%) rotate(-7deg)",
                backgroundColor: typeLogo.tint,
                maskImage: `url(${typeLogo.src})`,
                maskRepeat: "no-repeat",
                maskPosition: "center",
                maskSize: "contain",
              }}
            />
          ) : (
            <img
              src={typeLogo.src}
              alt={typeLogo.alt}
              aria-label={`${typeLogo.alt} agent`}
              className="absolute block h-[13cqw] w-[13cqw] object-contain drop-shadow-[0_1.5px_3px_rgba(0,0,0,0.4)]"
              style={{
                left: `${f(TYPE_LEFT_PCT)}%`,
                top: `${f(SPEC_TOP_PCT)}%`,
                transform: "translate(-50%, -50%) rotate(-7deg)",
              }}
            />
          ))}
          {/* Description snippet (grid variant): bottom-anchored, equal margins. */}
          {descSticker && (
            <GlassSticker
              key={descSticker.key}
              text={descSticker.text}
              textColor={descSticker.textColor}
              multiline
              onClick={descSticker.onClick}
              title={descSticker.title}
              style={{
                left: `${f(DESC_INSET_PCT)}%`,
                right: `${f(DESC_INSET_PCT)}%`,
                bottom: `${f(DESC_BOTTOM_PCT)}%`,
              }}
            />
          )}
          {/* Single-line chips (Reef / email): one centered rail near the foot. */}
          {railChips.length > 0 && (
            <div
              className="absolute inset-x-0 flex flex-wrap items-center justify-center gap-[2.4cqw] px-[7cqw]"
              style={{ bottom: `${f(RAIL_BOTTOM_PCT)}%` }}
            >
              {railChips.map((s) => (
                <GlassSticker
                  key={s.key}
                  text={s.text}
                  icon={s.icon}
                  textColor={s.textColor}
                  onClick={s.onClick}
                  title={s.title}
                  positioned={false}
                />
              ))}
            </div>
          )}
        </div>
    </div>
  );

  const outerCls = cn("w-full", SIZE_MAXW[size], className);
  return useTilt ? (
    <TiltCard max={tiltMax} className={outerCls}>{cardBox}</TiltCard>
  ) : (
    <div className={outerCls}>{cardBox}</div>
  );
}
