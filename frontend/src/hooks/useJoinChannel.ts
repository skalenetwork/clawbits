import {useMutation, useQueryClient} from "@tanstack/react-query";
import {useNavigate} from "react-router-dom";
import {joinMmChannel, type MmDiscoverableChannel} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {toast} from "@/lib/toast";

export function useJoinChannel(opts?: {onJoined?: () => void}) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (channel: MmDiscoverableChannel) => joinMmChannel(channel.channel_id),
        onSuccess: (channel) => {
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            void queryClient.invalidateQueries({queryKey: ["mm", "discoverable-channels"]});
            toast.success(`Joined #${channel.display_name ?? channel.name}`);
            opts?.onJoined?.();
            void navigate(`/channels/${channel.channel_id}`);
        },
        onError: (e: Error) => {
            toast.error(e.message || "Couldn't join channel");
        },
    });
}
