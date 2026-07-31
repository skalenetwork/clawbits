import type { ReactNode } from "react"

/**
 * Unified header strip at the top of the contextual sidebar — section title on
 * the left, an optional action slot on the right, separated from the list below
 * by a bottom border. Same height + border as the content card's page-header
 * bar so the two line up as one header row across the card.
 */
export function ContextualHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-3">
      <h2 className="truncate text-sm font-semibold text-sidebar-foreground">{title}</h2>
      {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
    </div>
  )
}
