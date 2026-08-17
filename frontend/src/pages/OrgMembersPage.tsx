import {useState} from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {UserAvatar} from "@/components/UserAvatar";
import {Icon} from "@/components/Icon";
import {
    Delete02Icon as Trash,
    UserAdd01Icon as UserPlus,
    UserMinus01Icon as UserMinus,
    UserMultiple02Icon as MembersIcon,
    LockIcon as Lock,
    MoreVerticalIcon as More,
    Logout01Icon as LogOut,
    ShieldKeyIcon as Shield,
    UserIcon as UserSingle,
} from "@hugeicons/core-free-icons";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {PageHeader} from "@/components/PageHeader";
import {EmptyState} from "@/components/EmptyState";
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
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {useAuth} from "@/context/AuthContext";
import {useActiveOrg} from "@/hooks/useActiveOrg";
import {
    addOrgMember, listOrgMembers, orgRoleLabel, removeOrgMember, updateOrgMemberRole,
    type OrgMember, type OrgRole,
} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {formatRelativeShort} from "@/lib/formatting";
import {toast} from "@/lib/toast";

function RoleBadge({role}: {role: OrgRole}) {
    const isAdmin = role === "owner";
    return (
        <span
            className={
                isAdmin
                    ? "inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
                    : "inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            }
        >
            {orgRoleLabel(role)}
        </span>
    );
}

export default function OrgMembersPage() {
    const { user, activeOrgId} = useAuth();
    const queryClient = useQueryClient();

    // Role comes from the active org's ``my_role`` (cheap, cached) so we
    // don't have to fetch the full members list just to find out whether
    // the caller can see the page. The members endpoint is owner-only on
    // the server, so we gate the request on ``canManage`` too.
    const {isOwner: canManage, isLoading: roleLoading} = useActiveOrg();

    const membersQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.orgMembers(activeOrgId) : ["org", "none", "members"],
        queryFn: () => listOrgMembers(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId) && canManage,
    });

    const members = membersQuery.data?.members ?? [];
    const ownerCount = members.filter(m => m.role === "owner").length;

    const [inviteOpen, setInviteOpen] = useState(false);
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<OrgRole>("member");
    const [memberToRemove, setMemberToRemove] = useState<OrgMember | null>(null);

    const addMutation = useMutation({
        mutationFn: (vars: {email: string; role: OrgRole}) =>
            addOrgMember(activeOrgId ?? "", vars.email, vars.role),
        onSuccess: (_data, vars) => {
            setEmail("");
            setRole("member");
            setInviteOpen(false);
            if (activeOrgId) {
                void queryClient.invalidateQueries({queryKey: queryKeys.orgMembers(activeOrgId)});
            }
            toast.success(`Added ${vars.email}`);
        },
        onError: (err: unknown) => {
            toast.error(err instanceof Error ? err.message : "Couldn't add member");
        },
    });

    const roleMutation = useMutation({
        mutationFn: (vars: {memberId: number; role: OrgRole}) =>
            updateOrgMemberRole(activeOrgId ?? "", vars.memberId, vars.role),
        onSuccess: (_data, vars) => {
            if (activeOrgId) {
                void queryClient.invalidateQueries({queryKey: queryKeys.orgMembers(activeOrgId)});
            }
            // ``my_role`` lives on the orgs query, and an admin can demote
            // themselves — refetch so this tab's own admin surfaces settle.
            void queryClient.invalidateQueries({queryKey: queryKeys.orgs});
            toast.success(
                vars.role === "owner" ? "Now an admin" : "Now a member",
            );
        },
        onError: (err: unknown) => {
            toast.error(err instanceof Error ? err.message : "Couldn't change role");
        },
    });

    const removeMutation = useMutation({
        mutationFn: (memberId: number) =>
            removeOrgMember(activeOrgId ?? "", memberId),
        onSuccess: () => {
            if (activeOrgId) {
                void queryClient.invalidateQueries({queryKey: queryKeys.orgMembers(activeOrgId)});
            }
            setMemberToRemove(null);
            toast.success("Member removed");
        },
        onError: (err: unknown) => {
            toast.error(err instanceof Error ? err.message : "Couldn't remove member");
        },
    });

    const handleAdd = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = email.trim();
        if (!trimmed) return;
        addMutation.mutate({email: trimmed, role});
    };

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }

    // Owner-only page. Role check first (cheap), then gate the members
    // fetch on it — the members endpoint itself is admin-only on the
    // server, so non-owners never trigger a 403.
    if (roleLoading) {
        return <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>;
    }
    if (!canManage) {
        return (
            <div className="space-y-6">
                <PageHeader icon={MembersIcon} title="Members"/>
                <EmptyState
                    icon={Lock}
                    title="Admins only"
                    description="Member management is restricted to organization admins. Ask an admin if you need to invite or remove people."
                />
            </div>
        );
    }

    const removingSelf = memberToRemove?.human_id === user?.id;

    return (
        <div className="space-y-6">
            <PageHeader
                icon={MembersIcon}
                title="Members"
                count={members.length}
                actions={
                    <Button size="sm" onClick={() => { setInviteOpen(true); }}>
                        <Icon icon={UserPlus} className="size-4"/>
                        Invite people
                    </Button>
                }
            />

            {membersQuery.isLoading && (
                <ul className="space-y-0.5">
                    {Array.from({length: 5}).map((_, i) => (
                        <li key={i} className="flex items-center gap-3 px-2 py-3">
                            <div className="size-9 shrink-0 animate-pulse rounded-full bg-muted"/>
                            <div className="flex-1 space-y-2">
                                <div className="h-3.5 w-40 animate-pulse rounded bg-muted"/>
                                <div className="h-3 w-56 animate-pulse rounded bg-muted"/>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            {membersQuery.isError && (
                <p className="py-16 text-center text-sm text-destructive">
                    {membersQuery.error instanceof Error ? membersQuery.error.message : "Failed to load members"}
                </p>
            )}
            {!membersQuery.isLoading && !membersQuery.isError && members.length === 0 && (
                <EmptyState
                    icon={MembersIcon}
                    title="No members yet"
                    description="People you invite to this organization will appear here."
                />
            )}

            {members.length > 0 && (
                <ul className="space-y-0.5">
                    {members.map((m: OrgMember) => {
                        const isMe = m.human_id === user?.id;
                        // The last admin is frozen: demoting or removing them
                        // would leave the org with nobody who can manage it,
                        // and the server refuses both. No menu, no dead items.
                        const isLastAdmin = m.role === "owner" && ownerCount <= 1;
                        const hasActions = canManage && !isLastAdmin;
                        const nextRole: OrgRole = m.role === "owner" ? "member" : "owner";
                        return (
                            <li
                                key={m.human_id}
                                className="flex items-center gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-muted/40"
                            >
                                <UserAvatar size={36} name={m.display_name ?? m.email} src={m.avatar?.url}/>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <p className="truncate text-sm font-medium">
                                            {m.display_name ?? m.email}
                                        </p>
                                        {isMe && (
                                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                                you
                                            </span>
                                        )}
                                    </div>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {m.email}
                                        {m.joined_at ? ` · joined ${formatRelativeShort(m.joined_at)}` : ""}
                                    </p>
                                </div>
                                <RoleBadge role={m.role}/>
                                {hasActions && (
                                    <DropdownMenu>
                                        <DropdownMenuTrigger
                                            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                                            aria-label={`Actions for ${isMe ? "you" : (m.display_name ?? m.email)}`}
                                        >
                                            <Icon icon={More} className="size-4"/>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem
                                                disabled={roleMutation.isPending}
                                                onClick={() => {
                                                    roleMutation.mutate({memberId: m.human_id, role: nextRole});
                                                }}
                                            >
                                                <Icon icon={nextRole === "owner" ? Shield : UserSingle}/>
                                                {nextRole === "owner"
                                                    ? "Make admin"
                                                    : (isMe ? "Step down to member" : "Change to member")}
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator/>
                                            <DropdownMenuItem
                                                variant="destructive"
                                                onClick={() => { setMemberToRemove(m); }}
                                            >
                                                <Icon icon={isMe ? LogOut : Trash}/>
                                                {isMe ? "Leave organization" : "Remove member"}
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            {/* Invite dialog — opened from the header action. */}
            <Dialog open={inviteOpen} onOpenChange={(next) => { if (!addMutation.isPending) setInviteOpen(next); }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            <Icon icon={UserPlus} className="text-muted-foreground"/>
                            Invite people
                        </DialogTitle>
                        <DialogDescription>
                            Add someone to this organization by email. They get access right away.
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={handleAdd} className="space-y-4">
                        <div className="space-y-1.5">
                            <label htmlFor="invite-email" className="text-xs font-medium text-muted-foreground">
                                Email
                            </label>
                            <Input
                                id="invite-email"
                                type="email"
                                autoFocus
                                value={email}
                                onChange={e => { setEmail(e.target.value); }}
                                placeholder="colleague@example.com"
                                disabled={addMutation.isPending}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label htmlFor="invite-role" className="text-xs font-medium text-muted-foreground">
                                Role
                            </label>
                            <select
                                id="invite-role"
                                value={role}
                                onChange={e => { setRole(e.target.value as OrgRole); }}
                                disabled={addMutation.isPending}
                                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                            >
                                <option value="member">Member</option>
                                <option value="owner">Admin</option>
                            </select>
                        </div>
                        <DialogFooter>
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() => { setInviteOpen(false); }}
                                disabled={addMutation.isPending}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={!email.trim() || addMutation.isPending}>
                                {addMutation.isPending ? "Adding…" : "Invite"}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            {/* Remove / leave confirmation. */}
            <Dialog
                open={memberToRemove !== null}
                onOpenChange={(next) => { if (!next && !removeMutation.isPending) setMemberToRemove(null); }}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            <Icon icon={removingSelf ? LogOut : UserMinus} className="text-destructive"/>
                            {removingSelf ? "Leave organization?" : "Remove member?"}
                        </DialogTitle>
                        <DialogDescription>
                            {memberToRemove && (
                                removingSelf ? (
                                    <>You'll lose access to this organization's channels and agents. This can't be undone.</>
                                ) : (
                                    <>
                                        <strong className="break-words">
                                            {memberToRemove.display_name ?? memberToRemove.email}
                                        </strong>{" "}
                                        will lose access to this organization's channels and agents. This can't be undone.
                                    </>
                                )
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => { setMemberToRemove(null); }}
                            disabled={removeMutation.isPending}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            onClick={() => { if (memberToRemove) removeMutation.mutate(memberToRemove.human_id); }}
                            disabled={removeMutation.isPending}
                        >
                            {removeMutation.isPending
                                ? (removingSelf ? "Leaving…" : "Removing…")
                                : (removingSelf ? "Leave" : "Remove")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
