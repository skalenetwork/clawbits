import type { ComponentType } from "react"
import { CubeIcon } from "@hugeicons/core-free-icons"
import { Icon } from "@/components/Icon"
import { HermesIcon, IronClawIcon, OpenClawIcon } from "@/components/agent-icons"

export interface AgentTypeMeta {
  name: string
  label: string
  Icon: ComponentType<{ className?: string }>
  enabled: boolean
  /** Short blurb for the create picker. */
  blurb: string
  /** CSS `background` (colour or gradient) for the avatar tile, per type. */
  tint: string
}

/** Generic fallback glyph (HugeIcons cube) for unknown agent types. */
function UnknownIcon({ className }: { className?: string }) {
  return <Icon icon={CubeIcon} className={className} />
}

/** The catalog the UI knows about (mirrors reef/agents.py). */
export const AGENT_TYPES: Record<string, AgentTypeMeta> = {
  openclaw: {
    name: "openclaw",
    label: "OpenClaw",
    Icon: OpenClawIcon,
    enabled: true,
    blurb: "Gateway + Control UI. Boots with a web UI you can log into.",
    // Theme-aware: light/dark gradients live in index.css (`--tint-openclaw`).
    tint: "var(--tint-openclaw)",
  },
  ironclaw: {
    name: "ironclaw",
    label: "IronClaw",
    Icon: IronClawIcon,
    enabled: true,
    blurb: "Rust agent + web gateway, with the clawbits channel baked in.",
    // Steel/iron tint (no dedicated CSS var yet).
    tint: "oklch(0.62 0.03 240 / 0.16)",
  },
  hermes: {
    name: "hermes",
    label: "Hermes",
    Icon: HermesIcon,
    enabled: true,
    blurb: "Hermes gateway + Clawbits platform plugin. Boots with dashboard config.",
    tint: "oklch(0.585 0.233 277.117 / 0.15)",
  },
}

const UNKNOWN: AgentTypeMeta = {
  name: "unknown",
  label: "Unknown",
  Icon: UnknownIcon,
  enabled: false,
  blurb: "",
  tint: "var(--muted)",
}

/** Ordered list for pickers (enabled first). */
export const AGENT_TYPE_LIST: AgentTypeMeta[] = Object.values(AGENT_TYPES).sort(
  (a, b) => Number(b.enabled) - Number(a.enabled),
)

export function agentMeta(type: string | null | undefined): AgentTypeMeta {
  return (type && AGENT_TYPES[type]) || UNKNOWN
}

// Mirrors the server's reef.agents.infer_type so a drift VM (no managed
// profile) resolves to the same type here as in the API — the hermes image tag
// `reef-hm:…` has no "hermes" substring, so the repo prefixes matter.
function inferFromImage(image: string | undefined): string {
  const i = (image ?? "").toLowerCase()
  if (i.includes("openclaw") || i.includes("reef-oc")) return "openclaw"
  if (i.includes("ironclaw") || i.includes("reef-ic")) return "ironclaw"
  if (i.includes("hermes") || i.includes("reef-hm")) return "hermes"
  return "unknown"
}

/** Resolve a fleet row/detail to its agent-type metadata. Prefers the server's
 *  `agent_type`, falling back to the managed profile or an image guess. */
export function agentTypeOf(e: {
  agent_type?: string | null
  profile?: string | null
  image?: string
}): AgentTypeMeta {
  const t =
    e.agent_type && e.agent_type !== "unknown"
      ? e.agent_type
      : (e.profile ?? inferFromImage(e.image))
  return agentMeta(t)
}
