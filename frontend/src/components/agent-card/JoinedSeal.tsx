/**
 * JoinedSeal — a small round "medal" that straddles the TOP edge of the card
 * (protruding above it): "JOINED" curved along the top arc and the join date
 * stacked in the middle (day+month on top, year below). A borderless disc —
 * white by default, dark on inverted (rare-black) cards; text uses the passed
 * accent colour. Renders an SVG `<g>` in the card's user space.
 */
import { useId } from "react";
import { arcTextPath } from "./shapes";

export function JoinedSeal({
  cx,
  cy,
  r,
  label,
  value,
  accent,
  disc = "#ffffff",
}: {
  cx: number;
  cy: number;
  r: number;
  label: string;
  value: string;
  accent: string;
  /** Disc fill. White by default; a dark value inverts the medal (dark disc +
   *  light ink) so it belongs to a dark card. */
  disc?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const arcId = `${uid}-arc`;
  const textR = r - 16; // curved label rides a bit further inside the top edge
  // Split "3 Jun 2026" → "3 Jun" (line 1) + "2026" (line 2).
  const parts = value.trim().split(/\s+/);
  const year = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
  const dayMon = parts.length > 1 ? parts.slice(0, -1).join(" ") : value;

  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={disc} />
      {/* "JOINED" curved over the top — bigger + more transparent */}
      <path id={arcId} d={arcTextPath(cx, cy, textR, 142)} fill="none" />
      <text fill={accent} fontSize={r * 0.24} fontWeight={700} letterSpacing={1.6} opacity={0.42}>
        <textPath href={`#${arcId}`} startOffset="50%" textAnchor="middle">
          {label}
        </textPath>
      </text>
      {/* Date, two lines: day+month, then year below */}
      <text textAnchor="middle" fill={accent} fontWeight={800}>
        <tspan x={cx} y={cy + r * 0.05} fontSize={r * 0.36}>
          {dayMon}
        </tspan>
        {year && (
          <tspan x={cx} y={cy + r * 0.4} fontSize={r * 0.27}>
            {year}
          </tspan>
        )}
      </text>
      <title>{`${label} ${value}`}</title>
    </g>
  );
}
