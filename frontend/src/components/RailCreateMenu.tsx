import {
    AddCircleIcon,
    CompassIcon,
    HashtagIcon,
    MessageAdd01Icon,
    Robot02Icon,
} from "@hugeicons/core-free-icons";
import type {IconSvgElement} from "@hugeicons/react";
import {Icon} from "@/components/Icon";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {openCreate} from "@/components/command/createStore";

/** One create-menu row: tinted icon square + title over a one-line hint.
 *  Hovering keeps every color in place — only a faint wash appears. The shared
 *  item style flips to accent and recolors every descendant on focus
 *  (``focus:**:text-accent-foreground`` — which reaches the SVG *paths*, past
 *  any color set on the svg itself), so the overrides below swap the bg for a
 *  subtle wash and the descendant rule for ``text-inherit``; the glyph + hint
 *  then hold their colors via inline styles. */
function CreateItem({
    icon,
    square,
    color,
    title,
    description,
    onSelect,
}: {
    icon: IconSvgElement;
    /** Tailwind classes for the square's tinted fill. */
    square: string;
    /** CSS color for the glyph, e.g. ``var(--color-blue-500)``. */
    color: string;
    title: string;
    description: string;
    onSelect: () => void;
}) {
    return (
        <DropdownMenuItem
            onClick={onSelect}
            className="cursor-pointer gap-3 focus:bg-foreground/5 focus:text-foreground not-data-[variant=destructive]:focus:**:text-inherit"
        >
            <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${square}`}>
                <Icon icon={icon} className="size-[18px]" style={{color}}/>
            </span>
            <span className="flex min-w-0 flex-col">
                <span>{title}</span>
                <span className="text-xs font-normal" style={{color: "var(--muted-foreground)"}}>
                    {description}
                </span>
            </span>
        </DropdownMenuItem>
    );
}

/**
 * "Create new" launcher for the rail's bottom cluster — a Slack-style create
 * menu: DM, channel (new/join), agent. Each row drives the shared create
 * dialogs (mounted once in the app shell via {@link CreateDialogs}), so the
 * menu works on every section without owning any dialog state itself.
 */
export function RailCreateMenu() {
    return (
            <DropdownMenu>
                <DropdownMenuTrigger
                    title="Create new"
                    aria-label="Create new"
                    // ``data-popup-open`` keeps the button visibly active while
                    // the menu is up (same fill as an active rail section).
                    className="flex size-9 items-center justify-center rounded-lg text-muted-foreground outline-hidden transition duration-100 hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground active:scale-90 data-[pressed]:scale-90 data-popup-open:bg-sidebar-foreground/10 data-popup-open:text-sidebar-foreground [-webkit-app-region:no-drag]"
                >
                    <Icon icon={AddCircleIcon} className="size-[18px]"/>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-72 p-1.5">
                    <CreateItem
                        icon={MessageAdd01Icon}
                        square="bg-blue-500/15"
                        color="var(--color-blue-500)"
                        title="Open DM"
                        description="Start a private conversation"
                        onSelect={() => { openCreate("dm"); }}
                    />
                    <CreateItem
                        icon={HashtagIcon}
                        square="bg-emerald-500/15"
                        color="var(--color-emerald-500)"
                        title="New channel"
                        description="Start a group conversation by topic"
                        onSelect={() => { openCreate("channel"); }}
                    />
                    <CreateItem
                        icon={CompassIcon}
                        square="bg-amber-500/15"
                        color="var(--color-amber-500)"
                        title="Join channel"
                        description="Browse public channels in your org"
                        onSelect={() => { openCreate("browse"); }}
                    />
                    <CreateItem
                        icon={Robot02Icon}
                        square="bg-violet-500/15"
                        color="var(--color-violet-500)"
                        title="New agent"
                        description="Create an AI teammate"
                        onSelect={() => { openCreate("agent"); }}
                    />
                </DropdownMenuContent>
            </DropdownMenu>
    );
}
