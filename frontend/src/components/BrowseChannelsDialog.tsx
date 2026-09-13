import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {
    ModalHeader,
    ModalList,
    ModalNote,
    ModalPanel,
    ModalRow,
    ModalSearch,
} from "@/components/modals/Modal";
import {useAuth} from "@/context/AuthContext";
import {listDiscoverableMmChannels} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {useJoinChannel} from "@/hooks/useJoinChannel";

export function BrowseChannelsDialog({open, onOpenChange}: {open: boolean; onOpenChange: (open: boolean) => void}) {
    const {activeOrgId} = useAuth();
    const [query, setQuery] = useState("");
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (!open) setQuery("");
    }

    const discoverableQuery = useQuery({
        queryKey: queryKeys.mm.discoverableChannels(activeOrgId),
        queryFn: () => listDiscoverableMmChannels(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId) && open,
    });
    const joinMutation = useJoinChannel({onJoined: () => { onOpenChange(false); }});

    const channels = discoverableQuery.data?.channels ?? [];
    const needle = query.trim().toLowerCase();
    const filtered = channels.filter(c =>
        (c.display_name ?? c.name).toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle),
    );

    return (
        <ModalPanel open={open} onOpenChange={onOpenChange} kind="picker">
            <ModalHeader
                title="Browse channels"
                description="Public channels in your organization. Join any to see its history and post."
            >
                <ModalSearch
                    value={query}
                    onChange={setQuery}
                    placeholder="Search channels"
                    disabled={joinMutation.isPending}
                />
            </ModalHeader>
            <ModalList>
                {discoverableQuery.isLoading ? (
                    <ModalNote>Loading…</ModalNote>
                ) : filtered.length === 0 ? (
                    <ModalNote>
                        {channels.length === 0
                            ? "You're already a member of every public channel."
                            : "No matches"}
                    </ModalNote>
                ) : (
                    filtered.map(c => (
                        <ModalRow
                            key={c.channel_id}
                            kind="channel"
                            name={c.display_name ?? c.name}
                            avatarUrl={c.avatar?.url}
                            note={`${String(c.member_count)} ${c.member_count === 1 ? "member" : "members"}`}
                            action={{
                                label: joinMutation.isPending && joinMutation.variables?.channel_id === c.channel_id
                                    ? "Joining…"
                                    : "Join",
                                onClick: () => { joinMutation.mutate(c); },
                                disabled: joinMutation.isPending,
                            }}
                        />
                    ))
                )}
            </ModalList>
        </ModalPanel>
    );
}
