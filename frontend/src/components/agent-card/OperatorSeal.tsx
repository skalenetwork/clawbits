/**
 * OperatorSeal — a small operator avatar inside a white "stamp" disc with
 * "Operated by {name}" curving along the lower outline. Renders an SVG `<g>`
 * embedded inside the card's `<svg>` (uses the card's user-space coords).
 *
 * Sits bottom-right, overlapping the main agent avatar (per the sketch).
 */
import { useId } from "react";

import { useResilientImage } from "./useResilientImage";

const f = (n: number) => n.toFixed(2);
const SEAL_INK = "#1a1714"; // black-ish text on the white seal

/** Best-effort FIRST name from a display name — which may be a real name
 *  ("Ada Lovelace"), an email fallback ("ada.lovelace@example.com"), or a
 *  handle ("ada.lovelace"). Strips any email domain, takes the first token
 *  (split on space / . / _ / -), caps the length, and title-cases the leading
 *  letter so lowercase handles read as a name. */
function firstName(raw: string): string {
  const trimmed = raw.trim();
  const local = trimmed.includes("@") ? (trimmed.split("@")[0] ?? trimmed) : trimmed;
  const token = local.split(/[\s._-]+/).find(Boolean) ?? local;
  const capped = token.slice(0, 14);
  return capped ? capped.charAt(0).toUpperCase() + capped.slice(1) : raw;
}

export function OperatorSeal({
  cx,
  cy,
  name,
  avatarUrl,
  avatarRadius = 24,
  accent = SEAL_INK,
}: {
  cx: number;
  cy: number;
  name: string;
  avatarUrl?: string | null;
  avatarRadius?: number;
  /** "Operated by" text colour (matches the JoinedSeal's accent). */
  accent?: string;
}) {
  const uid = useId().replace(/:/g, "");
  // Same resilience as the main card avatar: hold the letter until the SVG
  // loads so a not-yet-uploaded operator avatar never flashes a broken glyph.
  const resolvedAvatar = useResilientImage(avatarUrl);
  const ringId = `${uid}-ring`;
  const clipId = `${uid}-clip`;
  // Extra breathing room between the operator avatar and the "Operated by" arc.
  const textR = avatarRadius + 13; // text baseline radius
  const bgR = avatarRadius + 18; // seal disc radius (must clear the text)
  const labelSize = avatarRadius * 0.4; // scales with the seal so grid reads bigger
  const fallback = (name.trim().charAt(0) || "?").toUpperCase();
  const shortName = firstName(name);
  // Bottom arc (left→right through the bottom): text rides the lower outline,
  // centered under the avatar and reading right-side-up.
  const ringPath = `M ${f(cx - textR)} ${f(cy)} A ${f(textR)} ${f(textR)} 0 0 0 ${f(cx + textR)} ${f(cy)}`;

  return (
    <g>
      {/* Solid white seal disc. */}
      <circle cx={cx} cy={cy} r={bgR} fill="#ffffff" />
      {/* Curved label along the lower outline. */}
      <path id={ringId} d={ringPath} fill="none" />
      <text fill={accent} fontSize={labelSize} fontWeight={600} letterSpacing={0.6}>
        <textPath href={`#${ringId}`} startOffset="50%" textAnchor="middle">
          {`Operated by ${shortName}`}
        </textPath>
      </text>
      {/* Operator avatar. */}
      <clipPath id={clipId}>
        <circle cx={cx} cy={cy} r={avatarRadius} />
      </clipPath>
      {resolvedAvatar ? (
        <image
          href={resolvedAvatar}
          x={cx - avatarRadius}
          y={cy - avatarRadius}
          width={avatarRadius * 2}
          height={avatarRadius * 2}
          clipPath={`url(#${clipId})`}
          preserveAspectRatio="xMidYMid slice"
        />
      ) : (
        <>
          <circle cx={cx} cy={cy} r={avatarRadius} fill="#e7e2da" />
          <text
            x={cx}
            y={cy + avatarRadius * 0.34}
            textAnchor="middle"
            fontSize={avatarRadius}
            fontWeight={700}
            fill={SEAL_INK}
          >
            {fallback}
          </text>
        </>
      )}
      <circle cx={cx} cy={cy} r={avatarRadius} fill="none" stroke="#000000" strokeOpacity={0.12} strokeWidth={1.25} />
      <title>{`Operated by ${name}`}</title>
    </g>
  );
}
