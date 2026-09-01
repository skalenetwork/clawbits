import {Fragment} from "react";
import {useNavigate} from "react-router-dom";
import {useSelector} from "@tanstack/react-store";
import {Search01Icon} from "@hugeicons/core-free-icons";
import type {IconSvgElement} from "@hugeicons/react";
import {Icon} from "@/components/Icon";
import {cn} from "@/lib/utils";
import {isDesktop} from "@/lib/desktop";
import {Tooltip, TooltipContent, TooltipTrigger} from "@/components/ui/tooltip";
import {OrgSwitcher} from "@/components/OrgSwitcher";
import {RailCreateMenu} from "@/components/RailCreateMenu";
import {RailChats} from "@/components/RailChats";
import {RailNavShortcuts} from "@/components/RailNavShortcuts";
import {commandPaletteOpenAtom, openCommandPalette} from "@/components/command/paletteStore";
import {railSlotHintId, RAIL_SETTINGS_HINT_ID} from "@/lib/railSlots";
import {
    NAV_SECTIONS,
    SETTINGS_SECTION,
    type SectionId,
} from "@/lib/navSections";

/** Search rail icon — an action, not a route. Sits right after Home and opens
 *  the ⌘K command palette; it reads as active whenever that palette is open.
 *  Only the fields RailButton actually renders (label + icon) are needed. */
const SEARCH_RAIL: {label: string; icon: IconSvgElement} = {
    label: "Search",
    icon: Search01Icon,
};

/**
 * Thin, always-present icon rail down the left edge of the app. Replaces the
 * old top-of-sidebar mode-switcher tabs: the rail *is* the section switcher.
 *
 * Layout (top → bottom): org/workspace switcher · Home · Agents · chats
 * cluster · spacer · Create · Appearance · Settings. The rail floats over
 * ``--background`` (translucent on the desktop build, so the wallpaper shows
 * through); the opaque content card sits to its right.
 *
 * The chats cluster (``RailChats``) sits below Agents: a permanent **Pins**
 * section (one small avatar per pinned channel/DM) over a transient **Unread**
 * section (non-pinned chats with new messages), each avatar carrying a corner
 * counter, a right-side name tooltip, and a right-click menu. It's the rail's
 * scrolling region, so a long list scrolls within itself rather than pushing
 * the bottom-pinned Appearance / Settings cluster off-screen.
 */
function RailButton({
    section,
    active,
    onClick,
    hintId,
}: {
    /** Only ``label`` (tooltip + a11y) and ``icon`` are rendered, so a non-route
     *  action like Search can reuse this without being a full NavSection. */
    section: {label: string; icon: IconSvgElement};
    active: boolean;
    onClick: () => void;
    /** Shortcut-hint anchor id (``data-shortcut-hint``) so the hold-⌘ overlay
     *  can badge this icon with its ⌘-number. See RailNavShortcuts. */
    hintId?: string;
}) {
    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <button
                        type="button"
                        onClick={onClick}
                        data-shortcut-hint={hintId}
                        aria-label={section.label}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                            "relative flex size-9 items-center justify-center rounded-lg transition duration-100 active:scale-90",
                            active
                                ? "bg-sidebar-foreground/10 text-sidebar-foreground"
                                : "text-muted-foreground hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground",
                        )}
                    >
                        <Icon icon={section.icon} className="size-[18px]"/>
                    </button>
                }
            />
            <TooltipContent side="right" sideOffset={8} className="text-xs">
                {section.label}
            </TooltipContent>
        </Tooltip>
    );
}

export function AppRail({activeSection}: {activeSection: SectionId}) {
    const navigate = useNavigate();
    const searchActive = useSelector(commandPaletteOpenAtom);

    return (
        <nav
            aria-label="Primary"
            data-vt-sidebar=""
            // pt clears the macOS traffic lights / desktop title-bar pill
            // (``--titlebar-height`` is 0 on web, 38px on the desktop app).
            // On desktop we add a touch more so the org switcher sits a hair
            // lower than the bare title-bar height; the `max(…, 0.75rem)` floor
            // keeps web unchanged (the calc only wins once --titlebar-height
            // is non-zero). w-12 keeps the size-9 icons centered with a tight
            // 6px gutter on each side.
            className="flex w-12 shrink-0 flex-col items-center gap-1 pb-2 pt-[max(calc(var(--titlebar-height)_+_0.375rem),0.75rem)]"
        >
            {/* Desktop-only ⌘1…⌘9 rail navigation + ⌘, for Settings. Renders
                nothing; just registers the bindings. Web omits it (browsers
                claim ⌘-number for tab switching). */}
            {isDesktop && <RailNavShortcuts/>}

            {/* Org / workspace switcher — opens the workspace + profile menu.
                Sized to match the rail icons (see OrgSwitcher COMPACT_TRIGGER). */}
            <OrgSwitcher compact/>

            {/* Divider — sets the workspace/identity switcher apart from the
                nav cluster below, with a little extra breathing room beneath it. */}
            <div className="mt-1 mb-1.5 h-px w-7 shrink-0 bg-sidebar-border"/>

            {/* Primary nav: Home, Search, Agents. Home/Agents keep rail slots
                1 and 2 (⌘1 / ⌘2); Search sits between them as an action (⌘K),
                so it takes no numbered slot and reads active while the palette
                is open. */}
            {NAV_SECTIONS.map((section, i) => (
                <Fragment key={section.id}>
                    <RailButton
                        section={section}
                        active={activeSection === section.id}
                        onClick={() => { void navigate(section.landingPath); }}
                        hintId={railSlotHintId(i + 1)}
                    />
                    {section.id === "home" && (
                        <RailButton
                            section={SEARCH_RAIL}
                            active={searchActive}
                            onClick={() => { openCommandPalette(); }}
                        />
                    )}
                </Fragment>
            ))}

            {/* Chats — permanent pinned avatars over transient unread ones.
                Hides itself (no divider, no gap) when there are no pins and
                nothing unread; otherwise becomes the rail's scrolling region. */}
            <RailChats/>

            {/* Bottom-pinned: Create menu + Settings. Theme now lives in
                Settings > Appearance, so the standalone rail toggle is gone. */}
            <div className="mt-auto flex flex-col items-center gap-1">
                <RailCreateMenu/>
                <RailButton
                    section={SETTINGS_SECTION}
                    active={activeSection === "settings"}
                    onClick={() => { void navigate(SETTINGS_SECTION.landingPath); }}
                    hintId={RAIL_SETTINGS_HINT_ID}
                />
            </div>
        </nav>
    );
}
