import {useMutation, useQueryClient} from "@tanstack/react-query";
import {useNavigate} from "react-router-dom";
import {joinMmChannel, type MmDiscoverableChannel} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {toast} from "@/lib/toast";

/**
 * Canonical "join a discoverable channel" flow, shared by the channel
 * browser dialog and the home-page Discover section.
 *
 * On success it refreshes both the joined-channel list and the
 * discoverable list (so the joined channel drops out of "browse"), shows a
 * toast, runs the optional ``onJoined`` callback (e.g. close a dialog), and
 * navigates into the freshly joined channel.
 *
 * The returned mutation keeps its ``isPending`` / ``variables`` surface so
 * callers can render per-row "Joining…" state while a join is in flight.
 *
 * Note: the discoverable list is keyed ``["mm","discoverable",orgId]``
 * across the app (sidebar + browser dialog), so the broad
 * ``["mm","discoverable"]`` invalidation below refreshes every org's cache.
 */
export function useJoinChannel(opts?: {onJoined?: () => void}) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (channel: MmDiscoverableChannel) => joinMmChannel(channel.channel_id),
        onSuccess: (channel) => {
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            void queryClient.invalidateQueries({queryKey: ["mm", "discoverable"]});
            toast.success(`Joined #${channel.display_name ?? channel.name}`);
            opts?.onJoined?.();
            void navigate(`/channels/${channel.channel_id}`);
        },
        onError: (e: Error) => {
            toast.error(e.message || "Couldn't join channel");
        },
    });
}
