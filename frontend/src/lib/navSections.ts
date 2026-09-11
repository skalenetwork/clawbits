import {BubbleChatIcon, UserCircleIcon} from "@hugeicons/core-free-icons";
import type {IconSvgElement} from "@hugeicons/react";
import {Bot, House, type LucideIcon} from "lucide-react";

/** The sidebar's primary nav, top to bottom, numbered from ⌘1 on desktop.
 *  Skills is hidden for now: its routes still exist, it just has no nav entry. */
export const NAV_SECTIONS: {to: string; label: string; icon: LucideIcon}[] = [
    {to: "/home", label: "Home", icon: House},
    {to: "/agents", label: "Agents", icon: Bot},
];

/** Where the sidebar footer's Settings button and ⌘, land. */
export const SETTINGS_PATH = "/settings/profile";

// ── Mobile navigation ─────────────────────────────────────────────────────
// The mobile shell has no desktop sidebar; it navigates via a floating
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
        icon: Bot,
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
