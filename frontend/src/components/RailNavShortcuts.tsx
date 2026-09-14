import {useNavigate} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
import {useAuth} from "@/context/AuthContext";
import {useShortcut} from "@/lib/shortcuts";
import {listMmChannels} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {NAV_SECTIONS, SETTINGS_PATH} from "@/lib/navSections";

// Stops at 9: the desktop app's native View menu binds ⌘0 to "Actual Size".
const MAX_SLOTS = 9;

/** One ⌘-number binding, a component so the slot count can vary without
 *  breaking the rules of hooks. ``useShortcut`` re-mirrors ``run`` every
 *  render, so ``activate`` stays fresh without re-registering. */
function SlotBinding({number, activate}: {number: number; activate: () => void}) {
    useShortcut({
        id: `rail-nav-${String(number)}`,
        keys: `$mod+${String(number)}`,
        run: activate,
        hint: {label: String(number), group: "Navigation", description: `Jump to rail item ${String(number)}`},
    });
    return null;
}

/**
 * Desktop-only ⌘1…⌘9 navigation, counting straight down the sidebar: Home (1),
 * Agents (2), then each pinned chat (3…). ⌘, opens Settings (the macOS
 * Preferences convention). Mounted by DesktopShell behind ``isDesktop``:
 * browsers bind ⌘1…9 to tab switching.
 */
export function RailNavShortcuts() {
    const navigate = useNavigate();
    const {activeOrgId} = useAuth();
    useShortcut({
        id: "rail-settings",
        keys: "$mod+,",
        run: () => { void navigate(SETTINGS_PATH); },
        hint: {label: ",", group: "Navigation", description: "Open settings"},
    });

    const channelsQuery = useQuery({
        queryKey: queryKeys.mm.channels(activeOrgId ?? null),
        queryFn: () => listMmChannels(activeOrgId ?? null),
        enabled: Boolean(activeOrgId),
    });
    const paths = [
        ...NAV_SECTIONS.map((s) => s.to),
        ...(channelsQuery.data?.channels ?? []).filter((c) => c.pinned).map((c) => `/channels/${c.channel_id}`),
    ].slice(0, MAX_SLOTS);

    // Keyed by slot number, so a changed target only refreshes ``activate``.
    return paths.map((path, i) => (
        <SlotBinding key={i + 1} number={i + 1} activate={() => { void navigate(path); }}/>
    ));
}
