import type { AgentTypeMeta } from "@/lib/agentTypes"

// Operator-selectable dashboard accent colours. Mirrors reef/fleet.py AGENT_COLORS
// (same order). `null`/unset on an agent ⇒ fall back to the agent-type tint.
export const AGENT_COLORS = ["red", "green", "blue", "orange", "yellow", "violet"] as const
export type AgentColor = (typeof AGENT_COLORS)[number]

/** CSS `background` for an avatar tile, per colour (theme-aware vars in index.css). */
const COLOR_TINT: Record<AgentColor, string> = {
  red: "var(--tint-color-red)",
  green: "var(--tint-color-green)",
  blue: "var(--tint-color-blue)",
  orange: "var(--tint-color-orange)",
  yellow: "var(--tint-color-yellow)",
  violet: "var(--tint-color-violet)",
}

/** Solid swatch (the picker dot), per colour — readable on either theme. */
export const COLOR_SWATCH: Record<AgentColor, string> = {
  red: "oklch(0.64 0.21 25)",
  green: "oklch(0.70 0.16 150)",
  blue: "oklch(0.62 0.16 250)",
  orange: "oklch(0.71 0.16 55)",
  yellow: "oklch(0.82 0.15 95)",
  violet: "oklch(0.58 0.23 295)",
}

export const COLOR_LABEL: Record<AgentColor, string> = {
  red: "Red",
  green: "Green",
  blue: "Blue",
  orange: "Orange",
  yellow: "Yellow",
  violet: "Violet",
}

/** The avatar tile background for an entry: its chosen colour when set, else the
 *  agent-type tint (so today's default look is unchanged). */
export function tintFor(color: string | null | undefined, at: AgentTypeMeta): string {
  if (color && color in COLOR_TINT) return COLOR_TINT[color as AgentColor]
  return at.tint
}
