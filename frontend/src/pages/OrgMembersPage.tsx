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
    MoreHorizontalIcon as More,
    Logout01Icon as LogOut,
    ShieldKeyIcon as Shield,
    UserIcon as UserSingle,
} from "@hugeicons/core-free-icons";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {PageHeader} from "@/components/PageHeader";
import {EmptyState} from "@/components/EmptyState";
import {SettingsPage, SettingsRow, SettingsRowSkeleton, SettingsSection} from "@/components/settings/Settings";
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
import {formatRelativeAgo} from "@/lib/formatting";
import {errMsg, toast} from "@/lib/toast";

const ROLE_ITEMS = (["member", "owner"] as const).map(value => ({value, label: orgRoleLabel(value)}));

export default function OrgMembersPage() {
    const { user, activeOrgId} = useAuth();
    const queryClient = useQueryClient();

    // The members endpoint is admin-only on the server, so the fetch waits on
    // the cheap cached role check and non-admins never trigger a 403.
    const {isOwner: canManage, isLoading: roleLoading} = useActiveOrg();

    const membersQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.orgMembers(activeOrgId) : ["org", "none", "members"],
        queryFn: () => listOrgMembers(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId) && canManage,
    });

    const members = membersQuery.data?.members ?? [];
    const admins = members.filter(m => m.role === "owner");
    const sections = [
        {label: "Admins", members: admins},
        {label: "Members", members: members.filter(m => m.role === "member")},
    ].filter(s => s.members.length > 0);

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
            // themselves: refetch so this tab's own admin surfaces settle.
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

    const handleAdd = (e: React.SubmitEvent) => {
        e.preventDefault();
        const trimmed = email.trim();
        if (!trimmed) return;
        addMutation.mutate({email: trimmed, role});
    };

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }

    if (roleLoading) {
        return <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>;
    }
    if (!canManage) {
        return (
            <>
                <PageHeader icon={MembersIcon} title="Members"/>
                <EmptyState
                    icon={Lock}
                    title="Admins only"
                    description="Member management is restricted to organization admins. Ask an admin if you need to invite or remove people."
                />
            </>
        );
    }

    const removingSelf = memberToRemove?.human_id === user?.id;

    const memberRow = (m: OrgMember) => {
        const isMe = m.human_id === user?.id;
        const name = m.display_name ?? m.email;
        // The last admin is frozen: the server refuses to demote or remove
        // them, since nobody would be left to manage the org.
        const isLastAdmin = m.role === "owner" && admins.length <= 1;
        const nextRole: OrgRole = m.role === "owner" ? "member" : "owner";
        return (
            <SettingsRow
                key={m.human_id}
                leading={<UserAvatar size={32} name={name} src={m.avatar?.url}/>}
                title={
                    <>
                        {name}
                        {isMe && (
                            <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 align-middle text-[11px] font-medium text-muted-foreground">
                                You
                            </span>
                        )}
                    </>
                }
                description={
                    [name !== m.email && m.email, m.joined_at && `joined ${formatRelativeAgo(m.joined_at)}`]
                        .filter(Boolean)
                        .join(", ") || undefined
                }
                control={isLastAdmin ? undefined : (
                    <DropdownMenu>
                        <DropdownMenuTrigger
                            aria-label={`Actions for ${isMe ? "you" : name}`}
                            render={<Button variant="ghost" size="icon-sm"/>}
                        >
                            <Icon icon={More}/>
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
            />
        );
    };

    return (
        <>
            <PageHeader
                icon={MembersIcon}
                title="Members"
                count={members.length}
                actions={
                    <Button size="compact" onClick={() => { setInviteOpen(true); }}>
                        <Icon icon={UserPlus}/>
                        Invite people
                    </Button>
                }
            />

            <SettingsPage>
                {membersQuery.isLoading && (
                    <SettingsSection>
                        {Array.from({length: 3}, (_, i) => <SettingsRowSkeleton key={i}/>)}
                    </SettingsSection>
                )}
                {membersQuery.isError && (
                    <SettingsSection>
                        <SettingsRow
                            title="Couldn't load members"
                            error={errMsg(membersQuery.error, "Failed to load members")}
                        />
                    </SettingsSection>
                )}
                {membersQuery.isSuccess && members.length === 0 && (
                    <SettingsSection>
                        <EmptyState
                            icon={MembersIcon}
                            title="No members yet"
                            description="People you invite to this organization will appear here."
                            className="py-10"
                        />
                    </SettingsSection>
                )}
                {sections.map(s => (
                    <SettingsSection key={s.label} label={s.label}>
                        {s.members.map(memberRow)}
                    </SettingsSection>
                ))}
            </SettingsPage>

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
                            <Select
                                value={role}
                                items={ROLE_ITEMS}
                                onValueChange={(next) => { if (next) setRole(next); }}
                                disabled={addMutation.isPending}
                            >
                                <SelectTrigger id="invite-role">
                                    <SelectValue/>
                                </SelectTrigger>
                                <SelectContent>
                                    {ROLE_ITEMS.map(({value, label}) => (
                                        <SelectItem key={value} value={value}>{label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
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
        </>
    );
}
