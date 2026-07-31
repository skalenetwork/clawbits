import { Children, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowDown01Icon as ArrowDown } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/Icon";
import { cn } from "@/lib/utils";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

/**
 * A sidebar nav row that is BOTH a link (the main action) AND — when it has
 * children — independently collapsible to reveal a nested list. Clicking the
 * row navigates; a separate chevron toggles the nested items. An optional count
 * chip sits before the chevron. Open state persists per `id`.
 *
 * The disclosure uses the grid-rows `.disclosure` motion (see index.css): no
 * boxed accordion, no border rail — the reveal itself is the affordance, the
 * chevron is one rotating element, and freshly-revealed rows stagger in. Pass
 * children as plain <li> rows (add `disclosure-item` + `--i` for the stagger).
 */
export function SidebarNavItem({
  id,
  icon,
  label,
  to,
  isActive = false,
  count,
  defaultOpen = false,
  className,
  style,
  children,
}: {
  id: string;
  icon?: IconSvgElement;
  label: string;
  to: string;
  isActive?: boolean;
  count?: number;
  defaultOpen?: boolean;
  /** Forwarded to the `<li>` — lets a parent disclosure stagger rows in
   *  (`disclosure-item` + a per-row `--i`). */
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  // Count real children so an empty list (e.g. `items.map()` → []) reads as none.
  const hasChildren = Children.count(children) > 0;
  const storageKey = `fc_sidebar_tree_${id}`;
  // Don't gate the initial value on `hasChildren`: children (e.g. the inbox
  // preview) can load async AFTER mount, and the disclosure/chevron are only
  // rendered when `hasChildren` anyway — so an "open with no children yet" state
  // is harmless and lets `defaultOpen` survive the empty first render.
  const readOpen = () => {
    const stored = localStorage.getItem(storageKey);
    return stored == null ? defaultOpen : stored !== "false";
  };
  const [open, setOpen] = useState(readOpen);
  // The Agents sidebar lives OUTSIDE the routed outlet, so switching agents
  // reuses this same instance with a new `id` (inbox-a1 → inbox-a2). Re-derive
  // the open state from the NEW agent's stored key when `id` changes — otherwise
  // agent B inherits A's expand state and the first toggle corrupts B's key.
  // (Render-phase "adjust state on prop change", no effect.)
  const [prevId, setPrevId] = useState(id);
  if (id !== prevId) {
    setPrevId(id);
    setOpen(readOpen());
  }
  const toggle = () => {
    const next = !open;
    setOpen(next);
    localStorage.setItem(storageKey, String(next));
  };
  const showCount = typeof count === "number" && count > 0;

  return (
    <SidebarMenuItem className={className} style={style}>
      <SidebarMenuButton
        render={<Link to={to} viewTransition />}
        isActive={isActive}
        tooltip={label}
        className={cn(hasChildren && "pr-8")}
      >
        {icon && <Icon icon={icon} />}
        <span className="flex-1 truncate">{label}</span>
        {showCount && (
          <span
            className={cn(
              "ml-1 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums",
              isActive
                ? "bg-sidebar-foreground/15 text-sidebar-foreground"
                : "bg-sidebar-foreground/10 text-muted-foreground",
            )}
          >
            {count}
          </span>
        )}
      </SidebarMenuButton>
      {hasChildren && (
        <SidebarMenuAction
          onClick={toggle}
          aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
          aria-expanded={open}
          className="hover:bg-[var(--sb-hover)]"
        >
          <span className="disclosure-chevron inline-flex" data-open={open ? "true" : "false"}>
            <Icon icon={ArrowDown} />
          </span>
        </SidebarMenuAction>
      )}
      {hasChildren && (
        <div className="disclosure" data-open={open ? "true" : "false"}>
          <div className="disclosure-inner">
            {/* Nested tree guide: a hairline dropping from under the row's icon
                column; child rows hang off it. */}
            <ul className="ml-[17px] flex flex-col gap-0.5 border-l border-sidebar-border/70 py-1 pl-2 pr-1">
              {children}
            </ul>
          </div>
        </div>
      )}
    </SidebarMenuItem>
  );
}
