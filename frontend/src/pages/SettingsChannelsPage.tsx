import {useState} from "react";
import {Link} from "react-router-dom";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {Icon} from "@/components/Icon";
import {
    HashtagIcon as Hash,
    LockIcon as Lock,
    Delete02Icon as Trash,
    UserMultiple02Icon as Members,
    Calendar03Icon as Calendar,
    MoreVerticalIcon as More,
    Megaphone01Icon as Megaphone,
} from "@hugeicons/core-free-icons";
import {Avatar} from "@/components/Avatar";
import {EmptyState} from "@/components/EmptyState";
import {PageHeader} from "@/components/PageHeader";
import {Button} from "@/components/ui/button";
import {Switch} from "@/components/ui/switch";
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
    setOrgAttention,
    type MmAdminChannel,
} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {formatChannelTitle, formatRelativeShort} from "@/lib/formatting";
import {toast} from "@/lib/toast";

export default function SettingsChannelsPage() {
    const {activeOrgId} = useAuth();
    const queryClient = useQueryClient();
    const [channelToDelete, setChannelToDelete] = useState<MmAdminChannel | null>(null);

    // Owner-only page. Role comes from the active org's ``my_role`` (a
    // light query that's already cached by the org switcher) so non-owners
    // see the empty state instead of a flash-of-403 from the channels
    // endpoint. The API enforces the same check independently.
    const {org, isOwner, isLoading: roleLoading} = useActiveOrg();

    const attentionEnabled = Boolean(org?.attention_enabled);
    const attentionMutation = useMutation({
        mutationFn: (enabled: boolean) => setOrgAttention(activeOrgId ?? "", enabled),
        // Reflect the new state immediately; the org list is the source of truth
        // for ``attention_enabled`` (useActiveOrg reads it), so refetch it.
        onSuccess: () => {
            void queryClient.invalidateQueries({queryKey: queryKeys.orgs});
        },
        onError: (err: unknown) => {
            toast.error(err instanceof Error ? err.message : "Failed to update LobsterTalk attention");
        },
    });

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
            // Drop the now-deleted channel from anyone's sidebar list cache too.
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
            <div className="space-y-6">
                <PageHeader icon={Hash} title="Channels"/>
                <EmptyState
                    icon={Lock}
                    title="Owner-only"
                    description="Channel management is restricted to organization owners. Ask an owner if you need a channel removed."
                />
            </div>
        );
    }

    const channels = channelsQuery.data?.channels ?? [];
    const totalCount = channels.length;

    return (
        <div className="space-y-6">
            <PageHeader
                icon={Hash}
                title="Channels"
                count={totalCount > 0 ? totalCount : undefined}
            />

            <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3.5">
                <div className="flex min-w-0 items-start gap-3">
                    <Icon icon={Megaphone} className="mt-0.5 size-4 shrink-0 text-muted-foreground"/>
                    <div className="min-w-0">
                        <p className="text-sm font-medium">LobsterTalk attention</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                            Let agents chime into channel messages they weren't tagged in when a
                            triage step flags one they can help with. Each agent's operator still
                            opts in per agent.
                        </p>
                    </div>
                </div>
                <Switch
                    checked={attentionEnabled}
                    disabled={attentionMutation.isPending}
                    onCheckedChange={(next) => { attentionMutation.mutate(next); }}
                    aria-label="LobsterTalk attention for this organization"
                />
            </div>

            {channelsQuery.isLoading && (
                <ul className="space-y-0.5">
                    {Array.from({length: 5}).map((_, i) => (
                        <li key={i} className="flex items-center gap-3 py-3">
                            <div className="size-10 shrink-0 animate-pulse rounded-full bg-muted"/>
                            <div className="flex-1 space-y-2">
                                <div className="h-3.5 w-44 animate-pulse rounded bg-muted"/>
                                <div className="h-3 w-28 animate-pulse rounded bg-muted"/>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            {channelsQuery.isError && (
                <p className="py-16 text-center text-sm text-destructive">
                    {channelsQuery.error instanceof Error
                        ? channelsQuery.error.message
                        : "Failed to load channels"}
                </p>
            )}
            {!channelsQuery.isLoading && !channelsQuery.isError && channels.length === 0 && (
                <EmptyState
                    icon={Hash}
                    title="No channels yet"
                    description="Public and private channels in this organization will appear here."
                />
            )}

            {channels.length > 0 && (
                <ul className="space-y-0.5">
                    {channels.map(channel => (
                        <ChannelRow
                            key={channel.channel_id}
                            channel={channel}
                            onDelete={() => { setChannelToDelete(channel); }}
                        />
                    ))}
                </ul>
            )}

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
        </div>
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
    const isPrivate = channel.channel_type === "private";
    const lastActivity = channel.last_message_at ?? channel.created_at;

    return (
        <li className="flex items-stretch rounded-lg transition-colors hover:bg-muted/40">
            <Link
                to={`/channels/${encodeURIComponent(channel.channel_id)}`}
                className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-2 pr-3"
            >
                <Avatar
                    src={channel.avatar?.url ?? undefined}
                    name={channel.display_name ?? channel.name}
                    size={40}
                />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <Icon
                            icon={isPrivate ? Lock : Hash}
                            className="size-3.5 shrink-0 text-muted-foreground"
                        />
                        <p className="truncate text-sm font-medium">{label}</p>
                        <span
                            className={
                                isPrivate
                                    ? "inline-flex items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                                    : "inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                            }
                        >
                            {isPrivate ? "private" : "public"}
                        </span>
                    </div>
                    {channel.last_message_text && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {channel.last_message_text}
                        </p>
                    )}
                </div>
                <div className="hidden shrink-0 items-center gap-4 text-xs text-muted-foreground sm:flex">
                    <span className="inline-flex items-center gap-1.5">
                        <Icon icon={Members} className="size-3.5"/>
                        {channel.member_count} member{channel.member_count === 1 ? "" : "s"}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <Icon icon={Calendar} className="size-3.5"/>
                        {formatRelativeShort(lastActivity)}
                    </span>
                </div>
            </Link>
            <div className="flex shrink-0 items-center pr-1">
                <DropdownMenu>
                    <DropdownMenuTrigger
                        className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label={`Actions for ${label}`}
                    >
                        <Icon icon={More} className="size-4"/>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem variant="destructive" onClick={onDelete}>
                            <Icon icon={Trash}/> Delete channel
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </li>
    );
}
