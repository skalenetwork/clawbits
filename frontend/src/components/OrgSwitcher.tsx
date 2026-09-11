import {useState} from "react";
import {useLocation, useNavigate} from "react-router-dom";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {Check} from "lucide-react";
import {
    Building03Icon as Building,
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
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Button} from "@/components/ui/button";
import {UserAvatar} from "@/components/UserAvatar";
import {createOrg, getOrgs, markOrgVisited, type Org} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {useAuth} from "@/context/AuthContext";
import {toast} from "@/lib/toast";

function orgLabel(org: Org): string {
    const base = org.display_name ?? org.name;
    return org.is_personal ? `${base} (Personal)` : base;
}

/** Aggregate unread surfaced by the backend ``get_orgs_for_human`` query;
 *  already excludes channels the caller has muted, so we treat any value > 0
 *  as worth a badge. */
function orgUnread(org: Org): number {
    return Math.max(0, org.unread_count ?? 0);
}

/** ``last_visited_at`` is null until the user activates the org at least
 *  once. Used to flag freshly-invited orgs with a "New" pill so the user
 *  can tell at a glance they were just added somewhere. */
function orgIsNew(org: Org): boolean {
    return org.last_visited_at == null;
}

/** Monogram letters for a workspace: the first two characters of a
 *  single-word name, or the initials of the first two words. */
function orgInitials(org: Org): string {
    const raw = (org.display_name ?? org.name).trim();
    if (!raw) return "?";
    const words = raw.split(/\s+/).filter(Boolean);
    const initials = words.length >= 2
        ? words.slice(0, 2).map(w => w.charAt(0)).join("")
        : raw.slice(0, 2);
    return initials.toUpperCase();
}

/** A rounded-square monogram, so a workspace never reads as a round user avatar. */
function OrgMark({org}: {org: Org}) {
    return (
        <div
            aria-hidden="true"
            className="flex size-[18px] shrink-0 items-center justify-center rounded-md bg-sidebar-foreground/10 text-[10px] font-semibold uppercase tracking-tight text-sidebar-foreground"
        >
            {orgInitials(org)}
        </div>
    );
}

function slugifyOrgName(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 39);
}

/**
 * Consolidated identity menu at the top of the sidebar — owns workspace
 * switching, org-level admin shortcuts, and user-level actions (profile,
 * appearance, sign out). This replaces what used to be two separate
 * controls (org switcher at top + user menu at bottom).
 */
export function OrgSwitcher() {
    const {user, activeOrgId, setActiveOrgId, logout} = useAuth();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const location = useLocation();

    // When the user switches orgs while viewing org-scoped content (agent
    // profiles, channels), send them home — the referenced entity won't
    // exist in the new org.
    const switchOrg = (orgId: string) => {
        if (orgId === activeOrgId) return;
        setActiveOrgId(orgId);
        // Optimistically clear "New" + cross-org unread for the org we're
        // entering — the server bumps ``last_visited_at`` below and the
        // user's read pointers will land as they read channels, so the
        // next refetch will reconcile.
        queryClient.setQueryData<{organizations: Org[]; total: number}>(
            queryKeys.orgs,
            prev => prev && {
                ...prev,
                organizations: prev.organizations.map(o =>
                    o.org_id === orgId
                        ? {
                            ...o,
                            last_visited_at: new Date().toISOString(),
                            unread_count: 0,
                            unread_channel_count: 0,
                        }
                        : o,
                ),
            },
        );
        // Fire-and-forget — failure is non-fatal; the next ``getOrgs``
        // refetch will surface stale state if this didn't land.
        void markOrgVisited(orgId).catch(() => { /* best-effort */ });
        const path = location.pathname;
        if (path.startsWith("/agents/") || path.startsWith("/channels/")) {
            void navigate("/home");
        }
    };

    const orgsQuery = useQuery({
        queryKey: queryKeys.orgs,
        queryFn: () => getOrgs(),
    });

    const orgs = orgsQuery.data?.organizations ?? [];
    const activeOrg = orgs.find(o => o.org_id === activeOrgId) ?? null;
    // Any non-active org with unread messages or a never-visited flag —
    // drives the dot on the closed-dropdown trigger so the user knows
    // there's something to check without having to open the menu.
    const hasOtherActivity = orgs.some(
        o => o.org_id !== activeOrgId && (orgUnread(o) > 0 || orgIsNew(o)),
    );

    const [createOpen, setCreateOpen] = useState(false);
    const [newOrgDisplayName, setNewOrgDisplayName] = useState("");
    const newOrgSlug = slugifyOrgName(newOrgDisplayName);

    const createOrgMutation = useMutation({
        mutationFn: ({name, displayName}: {name: string; displayName: string}) =>
            createOrg(name, displayName || undefined),
        onSuccess: (org: Org) => {
            setCreateOpen(false);
            setNewOrgDisplayName("");
            void queryClient.invalidateQueries({queryKey: queryKeys.orgs});
            setActiveOrgId(org.org_id);
            toast.success(`Organization "${org.display_name ?? org.name}" created`);
        },
    });

    const handleCreate = () => {
        const displayName = newOrgDisplayName.trim();
        if (!displayName || !newOrgSlug) return;
        createOrgMutation.mutate({name: newOrgSlug, displayName});
    };

    const handleSignOut = () => {
        void logout();
        void navigate("/login");
    };

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-hidden transition-colors hover:bg-[var(--sb-hover)]">
                    <span className="relative flex shrink-0">
                        <UserAvatar size={28} name={user?.display_name ?? user?.email ?? ""} src={user?.avatar?.url}/>
                        {hasOtherActivity && (
                            <span
                                className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-[#FF3B30] ring-2 ring-sidebar dark:bg-[#FF453A]"
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
                        <DropdownMenuLabel>Switch organization</DropdownMenuLabel>
                        {orgs.map(org => {
                            const isActive = org.org_id === activeOrgId;
                            const unread = orgUnread(org);
                            // Suppress the activity indicators on the active row —
                            // the user is already here, anything unread will clear
                            // as they read it.
                            const showUnread = !isActive && unread > 0;
                            const showNew = !isActive && orgIsNew(org);
                            return (
                                <DropdownMenuItem
                                    key={org.org_id}
                                    onClick={() => { switchOrg(org.org_id); }}
                                >
                                    <OrgMark org={org}/>
                                    <span className="min-w-0 flex-1 truncate">{orgLabel(org)}</span>
                                    {showUnread && (
                                        <span
                                            className="ml-auto rounded-full bg-[#FF3B30] px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums text-white shadow-sm dark:bg-[#FF453A]"
                                            aria-label={`${unread} unread message${unread === 1 ? "" : "s"}`}
                                        >
                                            {unread > 99 ? "99+" : unread}
                                        </span>
                                    )}
                                    {showNew && !showUnread && (
                                        <span
                                            className="ml-auto rounded-full bg-blue-500 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide text-white dark:bg-blue-400"
                                            aria-label="You were recently added to this organization"
                                        >
                                            New
                                        </span>
                                    )}
                                    {isActive && (
                                        <Check className="ml-auto size-4 text-muted-foreground"/>
                                    )}
                                </DropdownMenuItem>
                            );
                        })}
                        {orgs.length === 0 && !orgsQuery.isLoading && (
                            <div className="px-2 py-1.5 text-xs text-muted-foreground">No organizations</div>
                        )}
                        <DropdownMenuItem
                            onClick={() => { setCreateOpen(true); }}
                            className="text-muted-foreground"
                        >
                            <Icon icon={Plus} className="size-4"/> New organization
                        </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator/>
                    <DropdownMenuItem onClick={() => { void navigate("/changelog"); }}>
                        <Icon icon={Sparkles} className="size-4"/>
                        <span className="flex-1">What&apos;s new</span>
                        <span className="ml-auto text-[10px] font-medium tabular-nums text-muted-foreground">
                            v{__BUILD_VERSION__}
                        </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleSignOut}>
                        <Icon icon={LogOut} className="size-4"/> Sign out
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>

            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>
                            <Icon icon={Building} className="text-muted-foreground"/>
                            Create organization
                        </DialogTitle>
                        <DialogDescription>
                            Organizations own agents and can have multiple members.
                        </DialogDescription>
                    </DialogHeader>
                    <form
                        onSubmit={e => {
                            e.preventDefault();
                            handleCreate();
                        }}
                        className="flex flex-col gap-3"
                    >
                        <div className="flex flex-col gap-1.5">
                            <label htmlFor="new-org-display" className="text-xs font-medium text-muted-foreground">
                                Organization name
                            </label>
                            <Input
                                id="new-org-display"
                                autoFocus
                                value={newOrgDisplayName}
                                onChange={e => { setNewOrgDisplayName(e.target.value); }}
                                placeholder="Acme Inc."
                                maxLength={128}
                                disabled={createOrgMutation.isPending}
                            />
                        </div>
                        <DialogFooter>
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() => { setCreateOpen(false); }}
                                disabled={createOrgMutation.isPending}
                            >
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                disabled={!newOrgSlug || createOrgMutation.isPending}
                            >
                                {createOrgMutation.isPending ? "Creating…" : "Create"}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    );
}
