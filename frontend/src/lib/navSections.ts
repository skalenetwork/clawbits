import {
    BubbleChatIcon,
    Home03Icon,
    Robot02Icon,
    Settings01Icon,
    UserCircleIcon,
} from "@hugeicons/core-free-icons";
import type {IconSvgElement} from "@hugeicons/react";

/** The top-level navigation sections, one per rail icon. Each owns a
 *  contextual sidebar inside the content card. (Chats was merged into Home.) */
export type SectionId = "home" | "agents" | "skills" | "settings";

export interface NavSection {
    id: SectionId;
    label: string;
    icon: IconSvgElement;
    /** Where clicking the rail icon lands. */
    landingPath: string;
}

/** Primary rail cluster, top → bottom. The org switcher sits above these
 *  (rendered separately at the very top); Settings is pinned at the bottom.
 *
 *  Skills is hidden for now: the section and its routes still exist, they just
 *  have no rail icon (re-add the entry to bring it back). */
export const NAV_SECTIONS: NavSection[] = [
    {id: "home", label: "Home", icon: Home03Icon, landingPath: "/home"},
    {id: "agents", label: "Agents", icon: Robot02Icon, landingPath: "/agents"},
];

/** Bottom-pinned rail icon. */
export const SETTINGS_SECTION: NavSection = {
    id: "settings",
    label: "Settings",
    icon: Settings01Icon,
    landingPath: "/settings/profile",
};

/**
 * Maps the current route to its rail section. The rail is the mode switcher.
 * Chats was merged into Home, so ``/home`` and ``/channels/*`` (plus the
 * dropped ``/feed`` / ``/townsquare``) all resolve to ``home`` — the hub that
 * hosts the chat list and the channel view.
 */
export function deriveSection(pathname: string): SectionId {
    if (pathname.startsWith("/agents")) return "agents";
    if (pathname.startsWith("/skills")) return "skills";
    if (pathname.startsWith("/settings")) return "settings";
    return "home";
}

/** Home shows the chat list, Agents the roster, Settings the nav, Skills the
 *  org's library (the selected skill opens in the pane beside it). */
export function sectionHasSidebar(section: SectionId): boolean {
    return ["home", "agents", "skills", "settings"].includes(section);
}

// ── Mobile navigation ─────────────────────────────────────────────────────
// The mobile shell has no rail/contextual-sidebar; it navigates via a floating
// 4-tab bottom-nav pill (+ a separate compose FAB). Tabs map to the SAME shared
// routes the desktop uses (no /m/* duplication) — the "stack" is browser
// history: tapping a chat pushes /channels/:id over the list, back pops.

export interface MobileTab {
    id: string;
    label: string;
    icon: IconSvgElement;
    /** Where tapping the tab lands. */
    path: string;
    /** Whether this tab is the active one for the given route. */
    match: (pathname: string) => boolean;
}

export const MOBILE_TABS: MobileTab[] = [
    {
        id: "chats",
        label: "Chats",
        icon: BubbleChatIcon,
        path: "/home",
        match: (p) => p === "/home" || p.startsWith("/channels"),
    },
    {
        id: "agents",
        label: "Agents",
        icon: Robot02Icon,
        path: "/agents",
        match: (p) => p.startsWith("/agents"),
    },
    {
        id: "you",
        label: "You",
        icon: UserCircleIcon,
        path: "/settings",
        match: (p) => p.startsWith("/settings"),
    },
];

/** A route that is "pushed" over a tab root on mobile — rendered full-screen
 *  with a back affordance and NO bottom nav (so a conversation is edge-to-edge
 *  and the composer never fights the floating bar). Settings sub-pages (e.g.
 *  ``/settings/appearance``) push over the ``/settings`` menu the "You" tab
 *  lands on, so the back chevron returns to that menu. The menu itself
 *  (``/settings``) is a tab root, not a pushed route. */
export function isPushedMobileRoute(pathname: string): boolean {
    return (
        /^\/skills(\/|$)/.test(pathname) ||
        /^\/channels\/[^/]+/.test(pathname) ||
        /^\/agents\/[^/]+/.test(pathname) ||
        /^\/settings\/.+/.test(pathname)
    );
}

/** Whether the floating bottom nav should render for this route. */
export function showMobileNav(pathname: string): boolean {
    return !isPushedMobileRoute(pathname);
}
