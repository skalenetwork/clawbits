import {useEffect, useMemo, useState} from "react";
import {useNavigate} from "react-router-dom";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Icon} from "@/components/Icon";
import {MessageAdd01Icon} from "@hugeicons/core-free-icons";
import {UserAvatar} from "@/components/UserAvatar";
import {AgentFaceAvatar} from "@/components/AgentFaceAvatar";
import {useAuth} from "@/context/AuthContext";
import {
    createOrGetMmDirect,
    getAgents,
    listOrgMembers,
    type AgentUser,
    type MmChannel,
    type OrgMember,
} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";

type Target =
    | {kind: "human"; id: number; label: string; sub: string; avatarUrl?: string | null}
    | {kind: "agent"; id: string; label: string; sub: string; avatarUrl?: string | null};

function targetKey(t: Target): string {
    return `${t.kind}:${String(t.id)}`;
}

interface NewDmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function NewDmDialog({open, onOpenChange}: NewDmDialogProps) {
    const {user, activeOrgId} = useAuth();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [query, setQuery] = useState("");

    useEffect(() => {
        if (!open) setQuery("");
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

    const targets = useMemo<Target[]>(() => {
        const humans = (membersQuery.data?.members ?? [])
            .filter((m: OrgMember) => m.human_id !== user?.id)
            .map<Target>(m => ({
                kind: "human",
                id: m.human_id,
                label: m.display_name ?? m.email,
                sub: m.email,
                avatarUrl: m.avatar?.url,
            }));
        const agents = (agentsQuery.data?.agents ?? [])
            // Contact is closed by default — only offer agents the viewer may DM.
            .filter((a: AgentUser) => a.can_dm !== false)
            .map<Target>((a: AgentUser) => ({
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
        if (!q) return targets;
        return targets.filter(t =>
            t.label.toLowerCase().includes(q) || t.sub.toLowerCase().includes(q),
        );
    }, [targets, query]);

    const openDmMutation = useMutation({
        mutationFn: (t: Target) => createOrGetMmDirect(activeOrgId ?? "", t.kind, String(t.id)),
        onSuccess: (channel: MmChannel) => {
            onOpenChange(false);
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            void navigate(`/channels/${channel.channel_id}`);
        },
        onError: (e: Error) => {
            toast.error(errMsg(e, "Couldn't start direct message"));
        },
    });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        <Icon icon={MessageAdd01Icon} className="text-muted-foreground"/>
                        New direct message
                    </DialogTitle>
                    <DialogDescription>
                        Pick anyone in your organization to start a private conversation.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <Input
                        autoFocus
                        value={query}
                        onChange={e => { setQuery(e.target.value); }}
                        placeholder="Search agents and people…"
                        disabled={openDmMutation.isPending}
                    />
                    <div className="max-h-80 overflow-y-auto rounded-lg border border-border/50 bg-background/40">
                        {filtered.length === 0 ? (
                            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                                {targets.length === 0 ? "No one else in this organization yet." : "No matches"}
                            </div>
                        ) : (
                            <ul className="divide-y divide-border/50">
                                {filtered.map(t => {
                                    const key = targetKey(t);
                                    const isPending = openDmMutation.isPending
                                        && openDmMutation.variables
                                        && targetKey(openDmMutation.variables) === key;
                                    return (
                                        <li key={key}>
                                            <button
                                                type="button"
                                                onClick={() => { openDmMutation.mutate(t); }}
                                                disabled={openDmMutation.isPending}
                                                className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
                                            >
                                                {t.kind === "agent" ? (
                                                    <AgentFaceAvatar name={t.label} src={t.avatarUrl} size={32} className="shrink-0"/>
                                                ) : (
                                                    <UserAvatar name={t.label} src={t.avatarUrl} size={32} className="shrink-0"/>
                                                )}
                                                <div className="min-w-0 flex-1">
                                                    <p className="break-words text-sm font-medium">{t.label}</p>
                                                    <p className="truncate text-xs text-muted-foreground">{t.sub}</p>
                                                </div>
                                                {isPending && (
                                                    <span className="text-xs text-muted-foreground">Opening…</span>
                                                )}
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
