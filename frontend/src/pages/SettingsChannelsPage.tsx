import {useState} from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {Icon} from "@/components/Icon";
import {
    HashtagIcon as Hash,
    LockIcon as Lock,
    Delete02Icon as Trash,
    MoreHorizontalIcon as More,
} from "@hugeicons/core-free-icons";
import {ChannelGlyph} from "@/components/ChannelGlyph";
import {EmptyState} from "@/components/EmptyState";
import {PageHeader} from "@/components/PageHeader";
import {SettingsPage, SettingsRow, SettingsRowSkeleton, SettingsSection} from "@/components/settings/Settings";
import {Button} from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {useAuth} from "@/context/AuthContext";
import {useActiveOrg} from "@/hooks/useActiveOrg";
import {
    deleteMmChannel,
    listAllOrgChannels,
    type MmAdminChannel,
} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {formatChannelTitle, formatRelativeAgo} from "@/lib/formatting";
import {errMsg, toast} from "@/lib/toast";

export default function SettingsChannelsPage() {
    const {activeOrgId} = useAuth();
    const queryClient = useQueryClient();
    const [channelToDelete, setChannelToDelete] = useState<MmAdminChannel | null>(null);

    // The channels endpoint is admin-only on the server, so the fetch waits on
    // the cheap cached role check and non-admins never flash a 403.
    const {isOwner, isLoading: roleLoading} = useActiveOrg();

    const channelsQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.orgChannels(activeOrgId) : ["org", "none", "channels"],
        queryFn: () => listAllOrgChannels(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId) && isOwner,
    });

    const deleteMutation = useMutation({
        mutationFn: (channelId: string) => deleteMmChannel(channelId),
        onSuccess: (_void, channelId) => {
            if (!activeOrgId) return;
            void queryClient.invalidateQueries({queryKey: queryKeys.orgChannels(activeOrgId)});
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channel(channelId)});
            const label = channelToDelete
                ? formatChannelTitle(channelToDelete.display_name ?? channelToDelete.name)
                : "Channel";
            setChannelToDelete(null);
            toast.success(`Deleted ${label}`);
        },
        onError: (err: unknown) => {
            toast.error(err instanceof Error ? err.message : "Failed to delete channel");
        },
    });

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }

    if (roleLoading) {
        return <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>;
    }

    if (!isOwner) {
        return (
            <>
                <PageHeader icon={Hash} title="Channels"/>
                <EmptyState
                    icon={Lock}
                    title="Admins only"
                    description="Channel management is restricted to organization admins. Ask an admin if you need a channel removed."
                />
            </>
        );
    }

    const channels = channelsQuery.data?.channels ?? [];
    const sections = [
        {label: "Public channels", channels: channels.filter(c => c.channel_type === "public")},
        {label: "Private channels", channels: channels.filter(c => c.channel_type === "private")},
    ].filter(s => s.channels.length > 0);

    return (
        <>
            <PageHeader
                icon={Hash}
                title="Channels"
                count={channels.length > 0 ? channels.length : undefined}
            />

            <SettingsPage>
                {channelsQuery.isLoading && (
                    <SettingsSection>
                        {Array.from({length: 3}, (_, i) => <SettingsRowSkeleton key={i}/>)}
                    </SettingsSection>
                )}
                {channelsQuery.isError && (
                    <SettingsSection>
                        <SettingsRow
                            title="Couldn't load channels"
                            error={errMsg(channelsQuery.error, "Failed to load channels")}
                        />
                    </SettingsSection>
                )}
                {channelsQuery.isSuccess && channels.length === 0 && (
                    <SettingsSection>
                        <EmptyState
                            icon={Hash}
                            title="No channels yet"
                            description="Public and private channels in this organization will appear here."
                            className="py-10"
                        />
                    </SettingsSection>
                )}
                {sections.map(s => (
                    <SettingsSection key={s.label} label={s.label}>
                        {s.channels.map(channel => (
                            <ChannelRow
                                key={channel.channel_id}
                                channel={channel}
                                onDelete={() => { setChannelToDelete(channel); }}
                            />
                        ))}
                    </SettingsSection>
                ))}
            </SettingsPage>

            <Dialog
                open={channelToDelete !== null}
                onOpenChange={(next) => {
                    if (!next && !deleteMutation.isPending) setChannelToDelete(null);
                }}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            <Icon icon={Trash} className="text-destructive"/>
                            Delete channel?
                        </DialogTitle>
                        <DialogDescription>
                            {channelToDelete && (
                                <>
                                    <strong className="break-words">
                                        {formatChannelTitle(
                                            channelToDelete.display_name ?? channelToDelete.name,
                                        )}
                                    </strong>{" "}
                                    and all of its messages, files, and members will be permanently
                                    removed. This can't be undone.
                                </>
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => { setChannelToDelete(null); }}
                            disabled={deleteMutation.isPending}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            onClick={() => {
                                if (channelToDelete) deleteMutation.mutate(channelToDelete.channel_id);
                            }}
                            disabled={deleteMutation.isPending}
                        >
                            {deleteMutation.isPending ? "Deleting…" : "Delete channel"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

function ChannelRow({
    channel,
    onDelete,
}: {
    channel: MmAdminChannel;
    onDelete: () => void;
}) {
    const label = formatChannelTitle(channel.display_name ?? channel.name);
    const members = `${channel.member_count} member${channel.member_count === 1 ? "" : "s"}`;
    const activity = channel.last_message_at
        ? `active ${formatRelativeAgo(channel.last_message_at)}`
        : `created ${formatRelativeAgo(channel.created_at)}`;

    return (
        <SettingsRow
            leading={<ChannelGlyph channel={channel} size={32}/>}
            title={label}
            to={`/channels/${encodeURIComponent(channel.channel_id)}`}
            description={`${members}, ${activity}`}
            control={
                <DropdownMenu>
                    <DropdownMenuTrigger
                        aria-label={`Actions for ${label}`}
                        render={<Button variant="ghost" size="icon-sm"/>}
                    >
                        <Icon icon={More}/>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem variant="destructive" onClick={onDelete}>
                            <Icon icon={Trash}/> Delete channel
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            }
        />
    );
}
