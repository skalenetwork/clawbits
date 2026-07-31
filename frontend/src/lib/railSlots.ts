/**
 * Shared numbering for the desktop ⌘1…⌘9 rail-navigation shortcuts. Kept in a
 * plain module (no components) so AppRail, RailChats, and RailNavShortcuts can
 * all agree on slot ids without tripping fast-refresh's component-only rule.
 *
 * Numbers count straight down the rail: Home (1), Agents (2) — the fixed nav
 * sections — then each pinned chat (3…), capped at {@link MAX_RAIL_SLOTS}.
 */
import {NAV_SECTIONS} from "@/lib/navSections";

/** Highest numbered rail slot. We stop at 9 because the desktop app's native
 *  View menu binds ⌘0 to "Actual Size" (zoom reset). */
export const MAX_RAIL_SLOTS = 9;

/** Slots consumed by the fixed nav sections (Home, Agents) before the chats
 *  begin — so a pinned chat at list index ``j`` is rail slot
 *  ``RAIL_CHAT_SLOT_OFFSET + 1 + j``. */
export const RAIL_CHAT_SLOT_OFFSET = NAV_SECTIONS.length;

/** Hint-target id for the Nth numbered rail icon. The registered shortcut and
 *  the ``data-shortcut-hint`` anchor on the rail button must use the same id so
 *  the hold-⌘ overlay badges the right element. */
export function railSlotHintId(n: number): string {
    return `rail-nav-${String(n)}`;
}

/** Hint-target id for the Settings shortcut (⌘,). */
export const RAIL_SETTINGS_HINT_ID = "rail-settings";
