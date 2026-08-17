import { useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"

// One flat, solid surface for every card - depth comes from the 3-tier tokens
// (background → panel → card), not blur or shadow. One radius, one border.
export const CARD = "rounded-xl border border-border bg-card"

// ── Chip system ────────────────────────────────────────────────────────────
// Soft-tinted, functional colour. Used sparingly - status, policy, "update".
export type ChipColor = "brand" | "green" | "blue" | "amber" | "red" | "violet" | "neutral"
type ChipSize = "sm" | "md"

const CHIP_COLOR: Record<ChipColor, string> = {
  brand: "bg-brand/12 text-brand",
  green: "bg-success/15 text-success",
  blue: "bg-sky-500/12 text-sky-600 dark:text-sky-400",
  amber: "bg-warning/15 text-warning",
  red: "bg-destructive/12 text-destructive",
  violet: "bg-violet-500/12 text-violet-600 dark:text-violet-400",
  neutral: "bg-muted/70 text-muted-foreground",
}
const CHIP_DOT: Record<ChipColor, string> = {
  brand: "bg-brand",
  green: "bg-success",
  blue: "bg-sky-500",
  amber: "bg-warning",
  red: "bg-destructive",
  violet: "bg-violet-500",
  neutral: "bg-muted-foreground/60",
}
const CHIP_SIZE: Record<ChipSize, string> = {
  sm: "gap-1 px-2 py-0.5 text-[11px]",
  md: "gap-1.5 px-2.5 py-1 text-xs",
}
const DOT_SIZE: Record<ChipSize, string> = { sm: "size-1", md: "size-1.5" }

export function Chip({
  color = "neutral",
  size = "md",
  icon,
  dot,
  title,
  children,
}: {
  color?: ChipColor
  size?: ChipSize
  icon?: ReactNode
  dot?: boolean
  title?: string
  children: ReactNode
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded-full font-medium",
        CHIP_COLOR[color],
        CHIP_SIZE[size],
      )}
    >
      {dot && <span className={cn("shrink-0 rounded-full", DOT_SIZE[size], CHIP_DOT[color])} />}
      {icon}
      {children}
    </span>
  )
}

/** A flat card with a header row (icon + title + optional right-aligned meta). */
export function Panel({
  icon,
  title,
  meta,
  className,
  children,
}: {
  icon?: ReactNode
  title: string
  meta?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={cn(CARD, "p-4", className)}>
      <div className="mb-3 flex items-center gap-2">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <h4 className="text-sm font-medium">{title}</h4>
        {meta && <div className="ml-auto">{meta}</div>}
      </div>
      {children}
    </section>
  )
}

/** The read-only env list, collapsed to the first chunk when long. Masked values
 *  (server-side "***") render as a "hidden" token. */
export function RuntimeEnvList({ env }: { env: Record<string, string> }) {
  const keys = Object.keys(env).sort()
  const [expanded, setExpanded] = useState(false)
  const LIMIT = 10
  const overflow = keys.length - LIMIT
  const shown = expanded ? keys : keys.slice(0, LIMIT)
  if (keys.length === 0) {
    return <p className="text-sm text-muted-foreground">No environment variables.</p>
  }
  return (
    <div className="space-y-1">
      {shown.map((k) => {
        const masked = env[k] === "***"
        return (
          <div key={k} className="flex items-start gap-2 font-mono text-xs leading-relaxed">
            <span className="shrink-0 text-muted-foreground/80">{k}</span>
            <span className="text-muted-foreground/50">=</span>
            {masked ? (
              <span className="rounded bg-muted/60 px-1.5 text-[11px] text-muted-foreground/70">
                hidden
              </span>
            ) : (
              <span className="break-all text-foreground">{env[k]}</span>
            )}
          </div>
        )
      })}
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((s) => !s)}
          className="mt-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? "Show less" : `Show all ${keys.length}`}
        </button>
      )}
    </div>
  )
}
