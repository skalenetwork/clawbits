import {useNavigate} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
import {useAuth} from "@/context/AuthContext";
import {useShortcut} from "@/lib/shortcuts";
import {listMmChannels} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {NAV_SECTIONS, SETTINGS_SECTION} from "@/lib/navSections";
import {
    MAX_RAIL_SLOTS,
    railSlotHintId,
    RAIL_SETTINGS_HINT_ID,
} from "@/lib/railSlots";

/** Registers one ⌘-number binding for a single rail slot. Split into its own
 *  component so the parent can render a variable number of slots (one per
 *  target) without breaking the rules of hooks. ``useShortcut`` re-mirrors
 *  ``run`` every render, so ``activate`` stays fresh without re-registering. */
function SlotBinding({number, activate}: {number: number; activate: () => void}) {
    useShortcut({
        id: railSlotHintId(number),
        keys: `$mod+${String(number)}`,
        run: activate,
        hint: {label: String(number), group: "Navigation", description: `Jump to rail item ${String(number)}`},
    });
    return null;
}

function SettingsBinding() {
    const navigate = useNavigate();
    useShortcut({
        id: RAIL_SETTINGS_HINT_ID,
        keys: "$mod+,",
        run: () => { void navigate(SETTINGS_SECTION.landingPath); },
        hint: {label: ",", group: "Navigation", description: "Open settings"},
    });
    return null;
}

/**
 * Desktop-only ⌘1…⌘9 rail navigation. Numbers count straight down the rail:
 * Home (1), Agents (2), then each pinned chat (3…), capped at {@link
 * MAX_RAIL_SLOTS}. Only the *stable* part of the rail is numbered — the
 * transient unread cluster is left out so a given ⌘-number always lands on the
 * same place. ⌘, opens Settings (the macOS Preferences convention).
 *
 * Mounted by {@link AppRail} behind an ``isDesktop`` check: browsers bind
 * ⌘1…9 to tab switching, so these only make sense in the tab-less desktop
 * webview. Bindings register with the central ShortcutProvider; the matching
 * ``data-shortcut-hint`` anchors live on the rail buttons (AppRail/RailChats).
 */
export function RailNavShortcuts() {
    const navigate = useNavigate();
    const {activeOrgId} = useAuth();

    // Same cache key the rail/sidebar already populate — React Query dedupes,
    // so reading it here is free and the pinned order matches RailChats.
    const channelsQuery = useQuery({
        queryKey: queryKeys.mm.channels(activeOrgId ?? null),
        queryFn: () => listMmChannels(activeOrgId ?? null),
        enabled: Boolean(activeOrgId),
    });
    const pinned = (channelsQuery.data?.channels ?? []).filter((c) => c.pinned);

    const targets: {key: string; activate: () => void}[] = [
        ...NAV_SECTIONS.map((s) => ({
            key: `nav:${s.id}`,
            activate: () => { void navigate(s.landingPath); },
        })),
        ...pinned.map((c) => ({
            key: `chat:${c.channel_id}`,
            activate: () => { void navigate(`/channels/${c.channel_id}`); },
        })),
    ].slice(0, MAX_RAIL_SLOTS);

    return (
        <>
            {/* Keyed by slot number, not target identity: when the target at a
                slot changes, only ``activate`` updates (fresh closure, no
                re-register); a slot mounts/unmounts only when the count changes. */}
            {targets.map((t, i) => (
                <SlotBinding key={i + 1} number={i + 1} activate={t.activate} />
            ))}
            <SettingsBinding />
        </>
    );
}
