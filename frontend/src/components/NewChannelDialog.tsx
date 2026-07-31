import {useEffect, useMemo, useState} from "react";
import {useNavigate} from "react-router-dom";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Icon} from "@/components/Icon";
import {
    Tick01Icon as Check,
    HashtagIcon as Hash,
    LockIcon as Lock,
} from "@hugeicons/core-free-icons";
import {UserAvatar} from "@/components/UserAvatar";
import {AgentFaceAvatar} from "@/components/AgentFaceAvatar";
import {useAuth} from "@/context/AuthContext";
import {
    addMmChannelMember,
    createMmChannel,
    getAgents,
    listOrgMembers,
    type AgentUser,
    type MmChannel,
    type OrgMember,
} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {toast} from "@/lib/toast";

function slugifyChannelName(raw: string): string {
    const slug = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || `channel-${String(Date.now())}`;
}

type Invitee =
    | {kind: "human"; id: number; label: string; sub: string; avatarUrl?: string | null}
    | {kind: "agent"; id: string; label: string; sub: string; avatarUrl?: string | null};

function inviteeKey(i: Invitee): string {
    return `${i.kind}:${String(i.id)}`;
}

interface NewChannelDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function NewChannelDialog({open, onOpenChange}: NewChannelDialogProps) {
    const {user, activeOrgId} = useAuth();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [name, setName] = useState("");
    const [visibility, setVisibility] = useState<"public" | "private">("public");
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (!open) {
            setName("");
            setVisibility("public");
            setQuery("");
            setSelected(new Set());
        }
    }, [open]);

    const membersQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.orgMembers(activeOrgId) : ["org-members", "none"],
        queryFn: () => listOrgMembers(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId) && open,
    });
    const agentsQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.agents(activeOrgId) : ["agents", "none"],
        queryFn: () => getAgents(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId) && open,
    });

    const invitees = useMemo<Invitee[]>(() => {
        const humans = (membersQuery.data?.members ?? [])
            .filter((m: OrgMember) => m.human_id !== user?.id)
            .map<Invitee>(m => ({
                kind: "human",
                id: m.human_id,
                label: m.display_name ?? m.email,
                sub: m.email,
                avatarUrl: m.avatar?.url,
            }));
        const agents = (agentsQuery.data?.agents ?? []).map<Invitee>((a: AgentUser) => ({
            kind: "agent",
            id: a.agent_id,
            label: a.display_name ?? a.nickname ?? a.agent_id,
            sub: "Agent",
            avatarUrl: a.avatar?.url,
        }));
        return [...agents, ...humans];
    }, [agentsQuery.data, membersQuery.data, user?.id]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return invitees;
        return invitees.filter(i =>
            i.label.toLowerCase().includes(q) || i.sub.toLowerCase().includes(q),
        );
    }, [invitees, query]);

    const toggle = (key: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const createChannelMutation = useMutation({
        mutationFn: async (displayName: string) => {
            if (!activeOrgId) throw new Error("No active organization");
            const channel = await createMmChannel(
                activeOrgId,
                slugifyChannelName(displayName),
                displayName.trim(),
                visibility,
            );
            const toInvite = invitees.filter(i => selected.has(inviteeKey(i)));
            for (const i of toInvite) {
                await addMmChannelMember(channel.channel_id, String(i.id), i.kind);
            }
            return channel;
        },
        onSuccess: (channel: MmChannel) => {
            onOpenChange(false);
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            const invited = selected.size;
            toast.success(
                invited > 0
                    ? `Created #${channel.display_name ?? channel.name} · invited ${String(invited)}`
                    : `Created #${channel.display_name ?? channel.name}`,
            );
            void navigate(`/channels/${channel.channel_id}`);
        },
    });

    const trimmed = name.trim();
    const submitting = createChannelMutation.isPending;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        <Icon icon={Hash} className="text-muted-foreground"/>
                        Create channel
                    </DialogTitle>
                    <DialogDescription>
                        Channels organize conversations around a topic. Invite people now or add them later.
                    </DialogDescription>
                </DialogHeader>
                <form
                    onSubmit={e => {
                        e.preventDefault();
                        if (!trimmed) return;
                        createChannelMutation.mutate(trimmed);
                    }}
                    className="flex flex-col gap-4"
                >
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor="new-channel-name" className="text-xs font-medium text-muted-foreground">
                            Channel name
                        </label>
                        <Input
                            id="new-channel-name"
                            autoFocus
                            value={name}
                            onChange={e => { setName(e.target.value); }}
                            placeholder="e.g. general"
                            maxLength={64}
                            disabled={submitting}
                        />
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Visibility</span>
                        <div role="radiogroup" className="grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                role="radio"
                                aria-checked={visibility === "public"}
                                onClick={() => { setVisibility("public"); }}
                                disabled={submitting}
                                className={`flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                                    visibility === "public"
                                        ? "border-primary bg-primary/5"
                                        : "border-border hover:bg-muted/50"
                                }`}
                            >
                                <span className="flex items-center gap-2 text-sm font-medium">
                                    <Icon icon={Hash} className="size-4"/> Public
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    Anyone in the org can join
                                </span>
                            </button>
                            <button
                                type="button"
                                role="radio"
                                aria-checked={visibility === "private"}
                                onClick={() => { setVisibility("private"); }}
                                disabled={submitting}
                                className={`flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                                    visibility === "private"
                                        ? "border-primary bg-primary/5"
                                        : "border-border hover:bg-muted/50"
                                }`}
                            >
                                <span className="flex items-center gap-2 text-sm font-medium">
                                    <Icon icon={Lock} className="size-4"/> Private
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    Invite-only
                                </span>
                            </button>
                        </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <label htmlFor="invite-search" className="text-xs font-medium text-muted-foreground">
                            Invite people {selected.size > 0 && `(${String(selected.size)} selected)`}
                        </label>
                        <Input
                            id="invite-search"
                            value={query}
                            onChange={e => { setQuery(e.target.value); }}
                            placeholder="Search agents and people…"
                            disabled={submitting}
                        />
                        <div className="max-h-60 overflow-y-auto rounded-lg border border-border/50 bg-background/40">
                            {filtered.length === 0 ? (
                                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                                    {invitees.length === 0 ? "No one else in this organization yet." : "No matches"}
                                </div>
                            ) : (
                                <ul className="divide-y divide-border/50">
                                    {filtered.map(i => {
                                        const key = inviteeKey(i);
                                        const isSelected = selected.has(key);
                                        return (
                                            <li key={key}>
                                                <button
                                                    type="button"
                                                    onClick={() => { toggle(key); }}
                                                    disabled={submitting}
                                                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/50"
                                                >
                                                    {i.kind === "agent" ? (
                                                        <AgentFaceAvatar name={i.label} src={i.avatarUrl} size={28}/>
                                                    ) : (
                                                        <UserAvatar name={i.label} src={i.avatarUrl} size={28}/>
                                                    )}
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-sm font-medium">{i.label}</p>
                                                        <p className="truncate text-xs text-muted-foreground">{i.sub}</p>
                                                    </div>
                                                    <div className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
                                                        isSelected
                                                            ? "border-primary bg-primary text-primary-foreground"
                                                            : "border-border"
                                                    }`}>
                                                        {isSelected && <Icon icon={Check} className="size-3"/>}
                                                    </div>
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => { onOpenChange(false); }}
                            disabled={submitting}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!trimmed || submitting}>
                            {submitting ? "Creating…" : "Create channel"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
