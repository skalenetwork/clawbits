import {useMemo} from "react";
import {useQuery} from "@tanstack/react-query";
import {useAuth} from "@/context/AuthContext";
import {listMmChannels} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {exportChatToDisk} from "@/lib/exportChat";
import type {ExtraAction} from "@/components/ExtraActionButton";

/** The DM channel name the server derives for a human↔agent pair — see
 *  ``create_or_get_direct`` in ``human_mm_endpoints.py``. Matching on it lets
 *  us find an existing DM from the already-cached channel list; the obvious
 *  alternative (``POST /mm/direct``) *creates* the DM when there isn't one,
 *  which is the last thing a delete dialog should do. A backend test pins the
 *  format so a server-side rename fails CI instead of quietly leaving this
 *  hook empty-handed. */
export function agentDmChannelName(humanId: number, agentId: string): string {
    return `dm-human-${humanId}-agent-${agentId}`;
}

/**
 * The "save your DM with this agent" action for the delete-agent dialog.
 *
 * Returns ``null`` when the caller has no DM with the agent — there is
 * nothing to save, and offering an export that resolves to an empty file
 * would be worse than offering nothing. Reads the same channel-list cache the
 * sidebar populates, so in the normal case this costs no extra request.
 */
export function useAgentDmExport(
    orgId: string | null,
    agentId: string | undefined,
): ExtraAction | null {
    const {user} = useAuth();

    const channelsQuery = useQuery({
        queryKey: queryKeys.mm.channels(orgId),
        queryFn: () => listMmChannels(orgId),
        enabled: Boolean(orgId),
    });

    const dmChannelId = useMemo(() => {
        if (!user || !agentId) return null;
        const name = agentDmChannelName(user.id, agentId);
        return (
            channelsQuery.data?.channels.find(
                (c) => c.channel_type === "direct" && c.name === name,
            )?.channel_id ?? null
        );
    }, [channelsQuery.data, user, agentId]);

    return useMemo(
        () =>
            dmChannelId
                ? {
                    label: "Export chat",
                    busyLabel: "Exporting…",
                    doneLabel: "Exported",
                    run: () => exportChatToDisk(dmChannelId),
                }
                : null,
        [dmChannelId],
    );
}
