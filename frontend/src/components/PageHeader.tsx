import {createContext, useContext, type ReactNode} from "react";
import {createPortal} from "react-dom";
import type {IconSvgElement} from "@hugeicons/react";
import {Icon} from "@/components/Icon";
import {Breadcrumbs, type Crumb} from "@/components/Breadcrumbs";

/**
 * The content card mounts a header-bar node (same bordered bar as the
 * sidebar's ContextualHeader) and shares it here. Each page renders
 * ``<PageHeader/>`` as before, but the content portals into that bar — so the
 * page header and the sidebar header line up as one header row across the card
 * (same height, same bottom border) instead of floating inside the scroll
 * area. When no slot is provided (e.g. the channel view, which owns its own
 * header) PageHeader renders nothing.
 */
const PageHeaderSlotContext = createContext<HTMLElement | null>(null);
export const PageHeaderSlotProvider = PageHeaderSlotContext.Provider;

interface PageHeaderProps {
    /** Hugeicons glyph before the title. Ignored when ``leading`` is set. */
    icon?: IconSvgElement;
    /** Custom leading element (e.g. a channel avatar) — overrides ``icon``. */
    leading?: ReactNode;
    /** Title — a plain string (truncated) or a custom node (e.g. name + a
     *  status pill) that manages its own overflow. Ignored when ``breadcrumb``
     *  is set. */
    title?: ReactNode;
    /** A breadcrumb trail — rendered instead of the title as a proper <nav>, so
     *  the leading crumbs stay put across navigation (no layout jump) and every
     *  section keeps its own clickable icon. */
    breadcrumb?: Crumb[];
    /** Small muted number rendered after the title — useful for counts. */
    count?: number;
    actions?: ReactNode;
}

export function PageHeader({icon, leading, title, breadcrumb, count, actions}: PageHeaderProps) {
    const slot = useContext(PageHeaderSlotContext);

    const content = (
        <>
            {breadcrumb ? (
                <Breadcrumbs items={breadcrumb} />
            ) : (
                <div className="flex min-w-0 items-center gap-2">
                    {leading ?? (icon && <Icon icon={icon} className="size-4 shrink-0 text-muted-foreground"/>)}
                    <h1 className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
                        {typeof title === "string" ? <span className="truncate">{title}</span> : title}
                        {typeof count === "number" && (
                            <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                                {count}
                            </span>
                        )}
                    </h1>
                </div>
            )}
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </>
    );

    if (!slot) return null;
    return createPortal(content, slot);
}
