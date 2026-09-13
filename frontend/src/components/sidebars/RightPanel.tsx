import type {ReactNode} from "react";
import {X} from "lucide-react";
import {SIDEBAR_SCROLL} from "@/components/ProgressiveBlur";
import {cn} from "@/lib/utils";

/** The right-edge panel, built like the main sidebar: a fixed header on the page header's row, one edge-faded
 *  scroller, an optional fixed footer. Width animates open and closed. */
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
            className="relative z-[45] hidden shrink-0 overflow-hidden bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-linear md:flex data-[state=collapsed]:w-0 data-[state=expanded]:w-(--sidebar-width)"
        >
            <div className="flex w-(--sidebar-width) shrink-0 flex-col">
                <div className="px-2">
                    <div data-tauri-drag-region className="flex h-(--header-height) items-center gap-2 pl-2.5">
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
                <div className={SIDEBAR_SCROLL}>{children}</div>
                {footer && <div className="px-2 pb-2">{footer}</div>}
            </div>
        </aside>
    );
}

export function PanelNote({error = false, children}: {error?: boolean; children: ReactNode}) {
    return <p className={cn("px-2.5 py-4 text-xs", error ? "text-destructive" : "text-muted-foreground")}>{children}</p>;
}
