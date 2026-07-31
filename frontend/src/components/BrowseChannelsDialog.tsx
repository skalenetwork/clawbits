import {useEffect, useMemo, useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Icon} from "@/components/Icon";
import {Avatar} from "@/components/Avatar";
import {
    HashtagIcon as Hash,
    UserMultiple02Icon as Members,
    Search01Icon as Search,
} from "@hugeicons/core-free-icons";
import {useAuth} from "@/context/AuthContext";
import {listDiscoverableMmChannels} from "@/lib/api";
import {useJoinChannel} from "@/hooks/useJoinChannel";

interface BrowseChannelsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function BrowseChannelsDialog({open, onOpenChange}: BrowseChannelsDialogProps) {
    const {activeOrgId} = useAuth();
    const [query, setQuery] = useState("");

    useEffect(() => {
        if (!open) setQuery("");
    }, [open]);

    const discoverableQuery = useQuery({
        queryKey: activeOrgId
            ? ["mm", "discoverable", activeOrgId]
            : ["mm", "discoverable", "none"],
        queryFn: () => listDiscoverableMmChannels(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId) && open,
    });

    const channels = discoverableQuery.data?.channels ?? [];

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return channels;
        return channels.filter(c =>
            (c.display_name ?? c.name).toLowerCase().includes(q)
            || c.name.toLowerCase().includes(q),
        );
    }, [channels, query]);

    const joinMutation = useJoinChannel({onJoined: () => { onOpenChange(false); }});

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        <Icon icon={Hash} className="text-muted-foreground"/>
                        Browse channels
                    </DialogTitle>
                    <DialogDescription>
                        Public channels in your organization. Join any to see its history and post.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <div className="relative">
                        <Icon
                            icon={Search}
                            className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none"
                        />
                        <Input
                            autoFocus
                            value={query}
                            onChange={e => { setQuery(e.target.value); }}
                            placeholder="Search channels…"
                            className="pl-8"
                            disabled={joinMutation.isPending}
                        />
                    </div>
                    <div className="max-h-80 overflow-y-auto rounded-lg border border-border/50 bg-background/40">
                        {discoverableQuery.isLoading ? (
                            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                                Loading…
                            </div>
                        ) : filtered.length === 0 ? (
                            <div className="flex flex-col items-center gap-1.5 px-3 py-8 text-center">
                                <Icon icon={Hash} className="size-6 text-muted-foreground/50"/>
                                <p className="text-sm font-medium text-muted-foreground">
                                    {channels.length === 0
                                        ? "No more channels to join"
                                        : "No matches"}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {channels.length === 0
                                        ? "You're already a member of every public channel."
                                        : "Try a different search term."}
                                </p>
                            </div>
                        ) : (
                            <ul className="divide-y divide-border/50">
                                {filtered.map(c => {
                                    const isJoining = joinMutation.isPending
                                        && joinMutation.variables?.channel_id === c.channel_id;
                                    const label = c.display_name ?? c.name;
                                    return (
                                        <li key={c.channel_id} className="flex items-center gap-3 px-3 py-2.5">
                                            <Avatar
                                                src={c.avatar?.url ?? undefined}
                                                name={label}
                                                size={32}
                                                className="shrink-0"
                                            />
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm font-medium">{label}</p>
                                                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                                                    <Icon icon={Members} className="size-3"/>
                                                    {c.member_count} {c.member_count === 1 ? "member" : "members"}
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => { joinMutation.mutate(c); }}
                                                disabled={joinMutation.isPending}
                                                className="rounded-md border border-border bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80 disabled:opacity-60 dark:bg-muted dark:text-foreground dark:hover:bg-muted/70"
                                            >
                                                {isJoining ? "Joining…" : "Join"}
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
