import {useCallback} from "react";
import {useLocation, useNavigate} from "react-router-dom";
import {useMutation, useQueryClient} from "@tanstack/react-query";
import {useAuth} from "@/context/AuthContext";
import {
    deleteMmChannel,
    leaveMmChannel,
    listMmChannelMembers,
    setMmChannelMuted,
    setMmChannelPinned,
    type MmChannel,
} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {exportChatToDisk} from "@/lib/exportChat";
import {draftStore} from "@/lib/messageDrafts";
import {toast} from "@/lib/toast";
import {confirm} from "@/lib/confirm";

type ChannelsCache = {channels: MmChannel[]; total: number};

export interface ChannelActions {
    togglePin: (channel: MmChannel) => void;
    toggleMute: (channel: MmChannel) => void;
    leave: (channel: MmChannel) => void;
    deleteChannel: (channel: MmChannel) => void;
    /** True when ``user`` created ``channel`` and may delete it outright. */
    canDelete: (channel: MmChannel) => boolean;
    copyLink: (channel: MmChannel) => void;
    copyId: (channel: MmChannel) => void;
    /** Download this conversation's history as a JSON file. */
    exportChat: (channel: MmChannel) => void;
}

/**
 * The per-channel actions (pin/mute/leave + clipboard) shared by every chat
 * surface — the desktop sidebar rows, the rail's pinned/unread avatars, and the
 * mobile long-press action sheet. Lifted out of ChatsSidebar so the optimistic
 * cache patching lives in exactly one place.
 *
 * Pin and mute patch the shared ``["mm","channels"]`` cache optimistically (a
 * prefix match, so every org-scoped list updates at once); ``useGlobalEvents``
 * reconciles over SSE. Leaving invalidates the list and clears the local draft.
 */
export function useChannelActions(): ChannelActions {
    const {user} = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const queryClient = useQueryClient();

    const patchChannel = useCallback(
        (channelId: string, patch: Partial<MmChannel>) => {
            queryClient.setQueriesData<ChannelsCache>(
                {queryKey: queryKeys.mm.channelsAll},
                (prev) => {
                    if (!prev) return prev;
                    const idx = prev.channels.findIndex((c) => c.channel_id === channelId);
                    if (idx < 0) return prev;
                    const channel = prev.channels[idx];
                    if (!channel) return prev;
                    const next = prev.channels.slice();
                    next[idx] = {...channel, ...patch};
                    return {...prev, channels: next};
                },
            );
        },
        [queryClient],
    );

    const muteMutation = useMutation({
        mutationFn: ({channelId, muted}: {channelId: string; muted: boolean}) =>
            setMmChannelMuted(channelId, muted),
        onMutate: ({channelId, muted}) => { patchChannel(channelId, {muted}); },
    });

    const pinMutation = useMutation({
        mutationFn: ({channelId, pinned}: {channelId: string; pinned: boolean}) =>
            setMmChannelPinned(channelId, pinned),
        onMutate: ({channelId, pinned}) => { patchChannel(channelId, {pinned}); },
    });

    const leaveMutation = useMutation({
        mutationFn: (channelId: string) => {
            if (!user) throw new Error("Not signed in");
            return leaveMmChannel(channelId, user.id);
        },
        onSuccess: (data, channelId) => {
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            // A channel the user left can't be replied into — drop its draft.
            if (user) draftStore.clear(user.id, channelId);
            toast.success(data.channel_deleted ? "Channel deleted" : "Left channel");
            if (location.pathname === `/channels/${channelId}`) void navigate("/home");
        },
    });

    const deleteMutation = useMutation({
        mutationFn: (channelId: string) => deleteMmChannel(channelId),
        onSuccess: (_data, channelId) => {
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            if (user) draftStore.clear(user.id, channelId);
            toast.success("Channel deleted");
            if (location.pathname === `/channels/${channelId}`) void navigate("/home");
        },
        onError: (err: unknown) => {
            toast.error(err instanceof Error ? err.message : "Couldn't delete channel");
        },
    });

    // "Save a copy before you destroy it" for the confirms below. Shares one
    // routine with the menu action so the toast, filename and — the part that
    // matters — the failure signalling stay identical: ``exportChatToDisk``
    // rethrows, which is how the dialog tells a saved copy from a failed one.
    const exportAction = useCallback(
        (channel: MmChannel) => ({
            label: "Export chat",
            busyLabel: "Exporting\u2026",
            doneLabel: "Exported",
            run: () => exportChatToDisk(channel.channel_id),
        }),
        [],
    );

    // Deleting a channel you created removes it for everyone, even when other
    // humans are still in it — so we always confirm first and name the blast
    // radius. Distinct from ``leave``, which only affects you (unless you're
    // the last human).
    const confirmAndDelete = useCallback(
        async (channel: MmChannel) => {
            const ok = await confirm({
                title: "Delete this channel?",
                description:
                    "This permanently deletes the channel and all of its messages for everyone. This can't be undone - export a copy first if you want to keep it.",
                confirmLabel: "Delete channel",
                extraAction: exportAction(channel),
            });
            if (!ok) return;
            deleteMutation.mutate(channel.channel_id);
        },
        [deleteMutation, exportAction],
    );

    // Leaving a channel as its last human member deletes it server-side, so
    // we confirm first in that case. DMs with an agent get copy that names
    // the consequence ("removes this conversation with the agent"); group/
    // public channels warn that the whole channel and its history go. When
    // other humans remain, leaving is non-destructive and runs immediately.
    const confirmAndLeave = useCallback(
        async (channel: MmChannel) => {
            if (!user) return;
            let lastHuman = false;
            let hasAgent = false;
            try {
                const {members} = await listMmChannelMembers(channel.channel_id);
                lastHuman =
                    members.filter((m) => m.human_id != null).length <= 1;
                hasAgent = members.some((m) => m.agent_id != null);
            } catch {
                // Couldn't read the roster — fall back to a generic confirm so
                // we never silently delete a channel the user didn't expect to.
                lastHuman = true;
            }
            if (lastHuman) {
                const isDmWithAgent =
                    channel.channel_type === "direct" && hasAgent;
                const ok = await confirm(
                    isDmWithAgent
                        ? {
                            title: "Leave this chat?",
                            description:
                                "You're the only person here. Leaving removes this conversation with the agent for good - it can't be undone. Export it first if you want to keep the transcript.",
                            confirmLabel: "Leave & delete",
                            extraAction: exportAction(channel),
                        }
                        : {
                            title: "Delete this channel?",
                            description:
                                "You're the last member. Leaving will permanently delete this channel and all of its messages. This can't be undone - export a copy first if you want to keep it.",
                            confirmLabel: "Leave & delete",
                            extraAction: exportAction(channel),
                        },
                );
                if (!ok) return;
            }
            leaveMutation.mutate(channel.channel_id);
        },
        [user, leaveMutation, exportAction],
    );

    const copyToClipboard = (text: string, label: string) => {
        void navigator.clipboard.writeText(text);
        toast.success(label);
    };

    return {
        togglePin: (c) => { pinMutation.mutate({channelId: c.channel_id, pinned: !c.pinned}); },
        toggleMute: (c) => { muteMutation.mutate({channelId: c.channel_id, muted: !c.muted}); },
        leave: (c) => { void confirmAndLeave(c); },
        deleteChannel: (c) => { void confirmAndDelete(c); },
        canDelete: (c) => Boolean(user) && c.created_by_human === user?.id,
        copyLink: (c) => {
            copyToClipboard(`${window.location.origin}/channels/${c.channel_id}`, "Link copied");
        },
        copyId: (c) => { copyToClipboard(c.channel_id, "Channel ID copied"); },
        exportChat: (c) => { void exportChatToDisk(c.channel_id); },
    };
}
