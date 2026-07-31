import { createContext, useContext, type ReactNode } from "react"
import { createPortal } from "react-dom"
import type { IconSvgElement } from "@hugeicons/react"
import { Icon } from "@/components/Icon"

/**
 * Pages render <PageHeader/> and its content portals into the content card's
 * unified header bar (the node provided via PageHeaderSlotProvider in App). The
 * bar lines up with the contextual sidebar's ContextualHeader so the two read
 * as one header row across the card. Renders nothing when no slot is mounted.
 */
const PageHeaderSlotContext = createContext<HTMLElement | null>(null)
export const PageHeaderSlotProvider = PageHeaderSlotContext.Provider

interface PageHeaderProps {
  icon?: IconSvgElement
  /** Custom leading node (e.g. an avatar) shown before the title; takes
   *  precedence over `icon`. */
  leading?: ReactNode
  title: ReactNode
  /** Small muted number rendered after the title — useful for counts. */
  count?: number
  /** Inline nodes shown right after the title (status badge, chips). */
  badges?: ReactNode
  actions?: ReactNode
}

export function PageHeader({ icon, leading, title, count, badges, actions }: PageHeaderProps) {
  const slot = useContext(PageHeaderSlotContext)

  const content = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {leading ?? (icon && <Icon icon={icon} className="size-4 shrink-0 text-muted-foreground" />)}
        <h1 className="flex min-w-0 items-baseline gap-2 truncate text-sm font-semibold tracking-tight text-foreground">
          <span className="truncate">{title}</span>
          {typeof count === "number" && (
            <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
              {count}
            </span>
          )}
        </h1>
        {badges && <div className="flex shrink-0 items-center gap-1.5">{badges}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </>
  )

  if (!slot) return null
  return createPortal(content, slot)
}
