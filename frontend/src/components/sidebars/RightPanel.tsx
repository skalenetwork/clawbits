import type {ReactNode} from "react";
import {X} from "lucide-react";
import {FOOTER_SCRIM, HeaderScrim} from "@/components/ProgressiveBlur";
import {cn} from "@/lib/utils";

/** The right-edge panel shell, styled like the main sidebar: flush, one
 *  scroller, a blurred sticky header that lines up with the page header, and
 *  an optional blurred sticky footer. Width animates open and closed. */
export function RightPanel({
    open,
    title,
    meta,
    onClose,
    below,
    footer,
    children,
}: {
    open: boolean;
    title: string;
    meta?: ReactNode;
    onClose: () => void;
    below?: ReactNode;
    footer?: ReactNode;
    children: ReactNode;
}) {
    return (
        <aside
            data-state={open ? "expanded" : "collapsed"}
            aria-hidden={!open}
            inert={!open}
            className="hidden shrink-0 overflow-hidden bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-linear md:flex data-[state=collapsed]:w-0 data-[state=expanded]:w-(--sidebar-width)"
        >
            <div className="no-scrollbar flex w-(--sidebar-width) shrink-0 flex-col overflow-y-auto px-2">
                <div className="sticky top-0 z-10 -mx-2 px-2 pb-3">
                    <HeaderScrim color="sidebar" inset/>
                    <div className="flex h-12 items-center gap-2 pl-2.5">
                        <h2 className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-medium">
                            <span className="truncate">{title}</span>
                            {meta}
                        </h2>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label={`Close ${title.toLowerCase()}`}
                            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--sb-hover)] hover:text-sidebar-foreground"
                        >
                            <X className="size-4"/>
                        </button>
                    </div>
                    {below}
                </div>
                <div className="flex-1">{children}</div>
                {footer && <div className={FOOTER_SCRIM}>{footer}</div>}
            </div>
        </aside>
    );
}

/** A panel's loading, error or empty line. */
export function PanelNote({error = false, children}: {error?: boolean; children: ReactNode}) {
    return <p className={cn("px-2.5 py-4 text-xs", error ? "text-destructive" : "text-muted-foreground")}>{children}</p>;
}
