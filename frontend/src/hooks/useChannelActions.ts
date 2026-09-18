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
import {isPairChannel} from "@/lib/chatFilters";
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
    canDelete: (channel: MmChannel) => boolean;
    copyLink: (channel: MmChannel) => void;
    copyId: (channel: MmChannel) => void;
    exportChat: (channel: MmChannel) => void;
}

export function useChannelActions(): ChannelActions {
    const {user} = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const queryClient = useQueryClient();

    const patchChannel = (channelId: string, patch: Partial<MmChannel>) => {
        queryClient.setQueriesData<ChannelsCache>({queryKey: queryKeys.mm.channelsAll}, (prev) =>
            prev?.channels.some((c) => c.channel_id === channelId)
                ? {...prev, channels: prev.channels.map((c) => (c.channel_id === channelId ? {...c, ...patch} : c))}
                : prev,
        );
    };

    const onRemoved = (channelId: string, message: string) => {
        void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
        if (user) draftStore.clear(user.id, channelId);
        toast.success(message);
        if (location.pathname === `/channels/${channelId}`) void navigate("/home");
    };

    const {mutate: saveMuted} = useMutation({
        mutationFn: ({channelId, muted}: {channelId: string; muted: boolean}) =>
            setMmChannelMuted(channelId, muted),
        onMutate: ({channelId, muted}) => { patchChannel(channelId, {muted}); },
    });

    const {mutate: savePinned} = useMutation({
        mutationFn: ({channelId, pinned}: {channelId: string; pinned: boolean}) =>
            setMmChannelPinned(channelId, pinned),
        onMutate: ({channelId, pinned}) => { patchChannel(channelId, {pinned}); },
    });

    const {mutate: leaveNow} = useMutation({
        mutationFn: ({channelId, humanId}: {channelId: string; humanId: number}) =>
            leaveMmChannel(channelId, humanId),
        onSuccess: (data, {channelId}) => {
            onRemoved(channelId, data.channel_deleted ? "Channel deleted" : "Left channel");
        },
    });

    const {mutate: deleteNow} = useMutation({
        mutationFn: (channelId: string) => deleteMmChannel(channelId),
        onSuccess: (_data, channelId) => { onRemoved(channelId, "Channel deleted"); },
        onError: (err: unknown) => {
            toast.error(err instanceof Error ? err.message : "Couldn't delete channel");
        },
    });

    const exportAction = (channel: MmChannel) => ({
        label: "Export chat",
        busyLabel: "Exporting…",
        doneLabel: "Exported",
        run: () => exportChatToDisk(channel.channel_id),
    });

    const confirmAndDelete = async (channel: MmChannel) => {
        const ok = await confirm({
            title: "Delete this channel?",
            description:
                "This permanently deletes the channel and all of its messages for everyone. This can't be undone - export a copy first if you want to keep it.",
            confirmLabel: "Delete channel",
            extraAction: exportAction(channel),
        });
        if (ok) deleteNow(channel.channel_id);
    };

    const confirmAndLeave = async (channel: MmChannel) => {
        if (!user) return;
        const members = (await listMmChannelMembers(channel.channel_id).catch(() => null))?.members;
        const lastHuman = !members || members.filter((m) => m.human_id != null).length <= 1;
        if (lastHuman) {
            const agentDm = isPairChannel(channel) && (members?.some((m) => m.agent_id != null) ?? false);
            const ok = await confirm({
                ...(agentDm
                    ? {
                        title: "Leave this chat?",
                        description:
                            "You're the only person here. Leaving removes this conversation with the agent for good - it can't be undone. Export it first if you want to keep the transcript.",
                    }
                    : {
                        title: "Delete this channel?",
                        description:
                            "You're the last member. Leaving will permanently delete this channel and all of its messages. This can't be undone - export a copy first if you want to keep it.",
                    }),
                confirmLabel: "Leave & delete",
                extraAction: exportAction(channel),
            });
            if (!ok) return;
        }
        leaveNow({channelId: channel.channel_id, humanId: user.id});
    };

    const copyToClipboard = (text: string, label: string) => {
        void navigator.clipboard.writeText(text);
        toast.success(label);
    };

    return {
        togglePin: (c) => { savePinned({channelId: c.channel_id, pinned: !c.pinned}); },
        toggleMute: (c) => { saveMuted({channelId: c.channel_id, muted: !c.muted}); },
        leave: (c) => { void confirmAndLeave(c); },
        deleteChannel: (c) => { void confirmAndDelete(c); },
        canDelete: (c) => user != null && c.created_by_human === user.id && !isPairChannel(c),
        copyLink: (c) => {
            copyToClipboard(`${window.location.origin}/channels/${c.channel_id}`, "Link copied");
        },
        copyId: (c) => { copyToClipboard(c.channel_id, "Channel ID copied"); },
        exportChat: (c) => { void exportChatToDisk(c.channel_id); },
    };
}
