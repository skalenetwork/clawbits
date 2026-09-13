import {useState} from "react";
import {useLocation, useNavigate} from "react-router-dom";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {Check} from "lucide-react";
import {
    PlusSignIcon as Plus,
    Logout01Icon as LogOut,
    SparklesIcon as Sparkles,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    ModalButton,
    ModalField,
    ModalFooter,
    ModalHeader,
    ModalPanel,
} from "@/components/modals/Modal";
import {Input} from "@/components/ui/input";
import {UserAvatar} from "@/components/UserAvatar";
import {createOrg, getOrgs, markOrgVisited, type Org} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {useAuth} from "@/context/AuthContext";
import {toast} from "@/lib/toast";

function orgLabel(org: Org): string {
    const base = org.display_name ?? org.name;
    return org.is_personal ? `${base} (Personal)` : base;
}

function orgInitials(org: Org): string {
    const raw = (org.display_name ?? org.name).trim();
    const words = raw.split(/\s+/);
    return (words.length > 1 ? words.slice(0, 2).map(w => w.charAt(0)).join("") : raw.slice(0, 2)) || "?";
}

function slugifyOrgName(raw: string): string {
    return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 39);
}

export function OrgSwitcher() {
    const {user, activeOrgId, setActiveOrgId, logout} = useAuth();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const location = useLocation();

    const switchOrg = (orgId: string) => {
        if (orgId === activeOrgId) return;
        setActiveOrgId(orgId);
        queryClient.setQueryData<{organizations: Org[]; total: number}>(
            queryKeys.orgs,
            prev => prev && {
                ...prev,
                organizations: prev.organizations.map(o =>
                    o.org_id === orgId
                        ? {...o, last_visited_at: new Date().toISOString(), unread_count: 0, unread_channel_count: 0}
                        : o,
                ),
            },
        );
        void markOrgVisited(orgId).catch(() => undefined);
        if (/^\/(agents|channels)\//.test(location.pathname)) void navigate("/home");
    };

    const orgsQuery = useQuery({queryKey: queryKeys.orgs, queryFn: getOrgs});
    const orgs = orgsQuery.data?.organizations ?? [];
    const activeOrg = orgs.find(o => o.org_id === activeOrgId);
    const hasOtherActivity = orgs.some(
        o => o.org_id !== activeOrgId && ((o.unread_count ?? 0) > 0 || o.last_visited_at == null),
    );

    const [createOpen, setCreateOpen] = useState(false);
    const [newOrgName, setNewOrgName] = useState("");
    const newOrgSlug = slugifyOrgName(newOrgName);

    const createOrgMutation = useMutation({
        mutationFn: (displayName: string) => createOrg(slugifyOrgName(displayName), displayName),
        onSuccess: org => {
            setCreateOpen(false);
            setNewOrgName("");
            void queryClient.invalidateQueries({queryKey: queryKeys.orgs});
            setActiveOrgId(org.org_id);
            toast.success(`Organization "${org.display_name ?? org.name}" created`);
        },
    });

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-hidden transition-colors hover:bg-[var(--sb-hover)]">
                    <span className="relative flex shrink-0">
                        <UserAvatar size={28} name={user?.display_name ?? user?.email ?? ""} src={user?.avatar?.url}/>
                        {hasOtherActivity && (
                            <span
                                className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-unread ring-2 ring-sidebar"
                                aria-label="Activity in another organization"
                            />
                        )}
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] leading-[15px] font-medium text-sidebar-foreground">
                            {user?.display_name ?? user?.email}
                        </span>
                        <span className="block truncate text-[11px] leading-[13px] text-muted-foreground">
                            {activeOrg ? orgLabel(activeOrg) : "Loading…"}
                        </span>
                    </span>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" sideOffset={6} className="min-w-64">
                    <DropdownMenuGroup>
                        {orgs.map(org => {
                            const isActive = org.org_id === activeOrgId;
                            const unread = isActive ? 0 : (org.unread_count ?? 0);
                            return (
                                <DropdownMenuItem key={org.org_id} onClick={() => { switchOrg(org.org_id); }}>
                                    <div
                                        aria-hidden="true"
                                        className="flex size-[18px] shrink-0 items-center justify-center rounded-md bg-sidebar-foreground/10 text-[10px] font-semibold uppercase tracking-tight text-sidebar-foreground"
                                    >
                                        {orgInitials(org)}
                                    </div>
                                    <span className="min-w-0 flex-1 truncate">{orgLabel(org)}</span>
                                    {unread > 0 ? (
                                        <span
                                            className="ml-auto rounded-full bg-unread px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums text-white shadow-sm"
                                            aria-label={`${unread} unread message${unread === 1 ? "" : "s"}`}
                                        >
                                            {unread > 99 ? "99+" : unread}
                                        </span>
                                    ) : !isActive && org.last_visited_at == null && (
                                        <span
                                            className="ml-auto rounded-full bg-blue-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white dark:bg-blue-400"
                                            aria-label="You were recently added to this organization"
                                        >
                                            New
                                        </span>
                                    )}
                                    {isActive && <Check className="ml-auto size-4 text-muted-foreground"/>}
                                </DropdownMenuItem>
                            );
                        })}
                        {orgs.length === 0 && !orgsQuery.isLoading && (
                            <div className="px-2.5 py-1.5 text-[13px] text-muted-foreground">No organizations</div>
                        )}
                        <DropdownMenuItem onClick={() => { setCreateOpen(true); }}>
                            <Icon icon={Plus}/> New organization
                        </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator/>
                    <DropdownMenuItem onClick={() => { void navigate("/changelog"); }}>
                        <Icon icon={Sparkles}/>
                        What&apos;s new
                        <DropdownMenuShortcut className="tabular-nums">v{__BUILD_VERSION__}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => {
                            void logout();
                            void navigate("/login");
                        }}
                    >
                        <Icon icon={LogOut}/> Sign out
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>

            <ModalPanel open={createOpen} onOpenChange={setCreateOpen} kind="form">
                <ModalHeader
                    title="Create organization"
                    description="Organizations own agents and can have multiple members."
                />
                <form
                    onSubmit={e => {
                        e.preventDefault();
                        if (newOrgSlug) createOrgMutation.mutate(newOrgName.trim());
                    }}
                >
                    <div className="p-4">
                        <ModalField label="Organization name" htmlFor="new-org-display">
                            <Input
                                id="new-org-display"
                                autoFocus
                                value={newOrgName}
                                onChange={e => { setNewOrgName(e.target.value); }}
                                placeholder="Acme Inc."
                                maxLength={128}
                                disabled={createOrgMutation.isPending}
                            />
                        </ModalField>
                    </div>
                    <ModalFooter>
                        <ModalButton
                            onClick={() => { setCreateOpen(false); }}
                            disabled={createOrgMutation.isPending}
                        >
                            Cancel
                        </ModalButton>
                        <ModalButton
                            type="submit"
                            tone="primary"
                            disabled={!newOrgSlug || createOrgMutation.isPending}
                        >
                            {createOrgMutation.isPending ? "Creating…" : "Create"}
                        </ModalButton>
                    </ModalFooter>
                </form>
            </ModalPanel>
        </>
    );
}
