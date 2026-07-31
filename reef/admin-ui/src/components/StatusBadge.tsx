import type { SandboxState } from "@/lib/api"
import { cn } from "@/lib/utils"

// Status colours are *functional* (agent lifecycle), so they survive the
// monochrome-chrome decision: success / warning / destructive map to the
// reef tokens, neutral states use muted. Mirrors clawbits' badge idiom
// (bg-<token>/15 + text-<token>).
const MAP: Record<SandboxState, { label: string; dot: string; cls: string }> = {
  running: { label: "Running", dot: "bg-success", cls: "bg-success/15 text-success" },
  creating: { label: "Creating", dot: "bg-warning animate-pulse", cls: "bg-warning/15 text-warning" },
  stopped: { label: "Stopped", dot: "bg-muted-foreground/60", cls: "bg-muted text-muted-foreground" },
  failed: { label: "Failed", dot: "bg-destructive", cls: "bg-destructive/15 text-destructive" },
  destroyed: {
    label: "Destroyed",
    dot: "bg-muted-foreground/40",
    cls: "bg-muted text-muted-foreground",
  },
}

export function StatusBadge({
  state,
  size = "sm",
}: {
  state: SandboxState
  /** "sm" (default) for dense lists; "md" matches the detail-header Chip size. */
  size?: "sm" | "md"
}) {
  const s = MAP[state] ?? MAP.failed
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full text-xs font-medium",
        size === "md" ? "px-2.5 py-1" : "px-2 py-0.5",
        s.cls,
      )}
    >
      <span className={cn("size-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  )
}
