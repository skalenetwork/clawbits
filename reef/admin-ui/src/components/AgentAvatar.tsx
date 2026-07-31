import { agentTypeOf } from "@/lib/agentTypes"
import type { FleetEntry, SandboxState } from "@/lib/api"
import { tintFor } from "@/lib/colors"
import { cn } from "@/lib/utils"

// Lifecycle-coloured dot (mirrors the sidebar / StatusBadge): functional colours
// that survive the otherwise-monochrome chrome.
const STATE_DOT: Record<SandboxState, string> = {
  running: "bg-success",
  creating: "bg-warning animate-pulse",
  stopped: "bg-muted-foreground/60",
  failed: "bg-destructive",
  destroyed: "bg-muted-foreground/40",
}

const SIZES = {
  sm: { tile: "size-[26px]", icon: "size-[18px]", dot: "size-2" },
  md: { tile: "size-10", icon: "size-7", dot: "size-2.5" },
  lg: { tile: "size-12", icon: "size-8", dot: "size-3" },
  xl: { tile: "size-20", icon: "size-14", dot: "size-4" },
} as const

type AvatarEntry = Pick<FleetEntry, "agent_type" | "profile" | "image" | "state" | "color">

/** An agent's identity glyph — its original logo on a per-type tinted tile, with
 *  an optional lifecycle state dot. Same treatment as the sidebar (shared so the
 *  two stay in sync); `size` picks the scale and `ringClass` should match the
 *  surface it sits on (`ring-sidebar`, `ring-card`) so the dot reads as a cut-out. */
export function AgentAvatar({
  entry,
  size = "md",
  ringClass = "ring-card",
  showState = true,
  className,
}: {
  entry: AvatarEntry
  size?: keyof typeof SIZES
  ringClass?: string
  showState?: boolean
  className?: string
}) {
  const at = agentTypeOf(entry)
  const s = SIZES[size]
  return (
    <span className={cn("relative flex shrink-0 items-center", className)}>
      <span
        className={cn("flex items-center justify-center overflow-hidden rounded-lg", s.tile)}
        style={{ background: tintFor(entry.color, at) }}
      >
        <at.Icon className={s.icon} />
      </span>
      {showState && (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 rounded-full ring-2",
            s.dot,
            ringClass,
            STATE_DOT[entry.state],
          )}
        />
      )}
    </span>
  )
}
