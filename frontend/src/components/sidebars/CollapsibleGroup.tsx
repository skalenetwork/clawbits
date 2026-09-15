import {useState, type ReactNode} from "react";
import {ChevronDown} from "lucide-react";
import {SidebarGroup, SidebarGroupContent, SidebarMenu} from "@/components/ui/sidebar";

/** A sidebar section that collapses from its header. The open state persists
 *  per ``id`` so it survives reloads. */
export function CollapsibleGroup({
    id,
    label,
    action,
    children,
}: {
    id: string;
    label: string;
    action?: ReactNode;
    children: ReactNode;
}) {
    const storageKey = `fc_sidebar_group_${id}`;
    const [open, setOpen] = useState(() => localStorage.getItem(storageKey) !== "false");
    const toggle = () => {
        setOpen(!open);
        localStorage.setItem(storageKey, String(!open));
    };
    return (
        <SidebarGroup className="p-0">
            <div className="group/section flex h-7 items-center pr-2.5">
                <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={open}
                    className="flex items-center gap-1 rounded-md px-2 text-[13px] font-medium text-muted-foreground transition-colors hover:text-sidebar-foreground"
                >
                    {label}
                    <span
                        className={`inline-flex transition-opacity ${open ? "opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100" : ""}`}
                    >
                        <span className="disclosure-chevron inline-flex" data-open={open}>
                            <ChevronDown className="size-3.5"/>
                        </span>
                    </span>
                </button>
                {action && <span className="ml-auto flex items-center">{action}</span>}
            </div>
            <div className="disclosure" data-open={open}>
                <div className="disclosure-inner">
                    <SidebarGroupContent>
                        <SidebarMenu>{children}</SidebarMenu>
                    </SidebarGroupContent>
                </div>
            </div>
        </SidebarGroup>
    );
}
