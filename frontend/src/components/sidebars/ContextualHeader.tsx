import type {ReactNode} from "react";

/**
 * Unified header strip at the top of every contextual sidebar — section title
 * on the left, an optional action slot on the right, separated from the list
 * below by a bottom border. Overlaid (absolute + translucent blur, same
 * treatment as the content card's page-header bar) so the list scrolls behind
 * it; the sidebar's scroll container clears it with top padding. The content
 * card already clears the desktop title bar, so this needs no traffic-light
 * padding of its own.
 *
 * ``title`` may be a node rather than a string, so a section whose title IS a
 * control (Skills, where the heading opens the scope menu) keeps the same bar
 * instead of hand-rolling one that drifts out of alignment.
 */
export function ContextualHeader({title, action}: {title: ReactNode; action?: ReactNode}) {
    return (
        <div className="absolute inset-x-0 top-0 z-10 flex h-12 items-center justify-between gap-2 border-b border-sidebar-border bg-panel/80 px-3 backdrop-blur-xl supports-[backdrop-filter]:bg-panel/65">
            {typeof title === "string" ? (
                <h2 className="truncate text-sm font-semibold text-sidebar-foreground">{title}</h2>
            ) : (
                <h2 className="flex min-w-0 flex-1 items-center">{title}</h2>
            )}
            {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
        </div>
    );
}
