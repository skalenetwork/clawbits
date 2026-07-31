import {useState, type ReactNode} from "react";
import {ArrowDown01Icon as ArrowDown} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {SidebarGroup, SidebarGroupContent, SidebarMenu} from "@/components/ui/sidebar";

/**
 * A contextual-sidebar group whose body can be hidden via the header. State
 * persists per `id` in localStorage so the user's preference survives reloads
 * and section switches.
 *
 * The header is a quiet sentence-case label with a LEADING chevron (one
 * rotating element); the body animates via the grid-rows `.disclosure` motion
 * (see index.css) rather than remounting — no boxes, no rules, just the reveal.
 *
 * Shared by the Chats and Settings contextual sidebars.
 */
export function CollapsibleGroup({
    id,
    label,
    action,
    defaultOpen = true,
    children,
}: {
    id: string;
    label: string;
    action?: ReactNode;
    defaultOpen?: boolean;
    children: ReactNode;
}) {
    const storageKey = `fc_sidebar_group_${id}`;
    const [open, setOpen] = useState(() => {
        const stored = localStorage.getItem(storageKey);
        return stored == null ? defaultOpen : stored !== "false";
    });
    const toggle = () => {
        const next = !open;
        setOpen(next);
        localStorage.setItem(storageKey, String(next));
    };
    return (
        <SidebarGroup className="px-0 py-1 first:pt-0">
            <div className="flex items-center gap-1">
                <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={open}
                    className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground/80 transition-colors hover:text-sidebar-foreground"
                >
                    <span className="disclosure-chevron inline-flex" data-open={open ? "true" : "false"}>
                        <Icon icon={ArrowDown} className="size-3" />
                    </span>
                    <span className="truncate">{label}</span>
                </button>
                {action && <span className="shrink-0">{action}</span>}
            </div>
            <div className="disclosure" data-open={open ? "true" : "false"}>
                <div className="disclosure-inner">
                    <SidebarGroupContent>
                        <SidebarMenu>{children}</SidebarMenu>
                    </SidebarGroupContent>
                </div>
            </div>
        </SidebarGroup>
    );
}
