import type { ReactNode } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
    Settings01Icon as SettingsIcon,
    Notification03Icon as Bell,
    PaintBrush01Icon as PaintBrush,
    LockIcon as PrivacyLock,
    Link01Icon as LinkIcon,
    Logout01Icon as LogOut,
    ArrowRight01Icon as ChevronRight,
    Tick01Icon as Check,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

import { Icon } from "@/components/Icon";
import { UserAvatar } from "@/components/UserAvatar";
import { PageHeader } from "@/components/PageHeader";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/context/AuthContext";
import { getOrgs, markOrgVisited, type Org } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

/**
 * The mobile "You" tab landing — an iOS-style grouped settings menu. The desktop
 * shell reaches every settings sub-page through the contextual SettingsSidebar,
 * but the mobile shell has no such rail, so the "You" tab used to dead-end on the
 * Profile page with no way to reach Appearance / Privacy / workspace switching.
 *
 * This menu is that missing index: tapping a row pushes the existing settings
 * sub-page (rendered full-screen with a back chevron by MobileShell). Theme
 * switching lives behind the Appearance row, reusing SettingsAppearancePage as-is
 * — no duplicated control. Org switching stays here too so multi-org users can't
 * be stranded on a single workspace.
 *
 * On desktop this route just redirects to Profile; the sidebar owns nav there.
 */
export default function SettingsMenuPage() {
    const isMobile = useIsMobile();
    const navigate = useNavigate();
    const { user, activeOrgId, setActiveOrgId, logout } = useAuth();

    const orgsQuery = useQuery({
        queryKey: queryKeys.orgs,
        queryFn: () => getOrgs(),
        staleTime: 60_000,
    });
    const orgs = orgsQuery.data?.organizations ?? [];

    // Desktop already exposes settings nav through the contextual sidebar — the
    // menu is a mobile-only affordance. Hooks above run first so this stays a
    // valid conditional return.
    if (!isMobile) return <Navigate to="/settings/profile" replace />;

    const fallbackName = user?.display_name ?? user?.email ?? "Your profile";

    // The menu isn't org-scoped, so switching workspace can stay put — no
    // navigate-home dance the org-scoped views need. ``markOrgVisited`` clears
    // the "new" flag; the next ``getOrgs`` refetch reconciles unread counts.
    const switchOrg = (orgId: string) => {
        if (orgId === activeOrgId) return;
        setActiveOrgId(orgId);
        void markOrgVisited(orgId).catch(() => {
            // Non-fatal — the next getOrgs refetch reconciles the visited flag.
        });
    };

    const handleSignOut = () => {
        void (async () => {
            await logout();
            void navigate("/login");
        })();
    };

    return (
        <div className="space-y-6">
            <PageHeader icon={SettingsIcon} title="Settings" />

            {/* Identity → Profile. The whole card is the tap target. */}
            <button
                type="button"
                onClick={() => { void navigate("/settings/profile"); }}
                className="flex w-full items-center gap-3.5 rounded-xl border border-border/50 bg-card p-4 text-left transition active:scale-[0.99]"
            >
                <UserAvatar
                    size={52}
                    name={fallbackName}
                    src={user?.avatar?.url}
                    className="shrink-0 rounded-xl"
                />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-semibold">{fallbackName}</p>
                    {user?.email && (
                        <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                    )}
                </div>
                <Icon icon={ChevronRight} className="size-4 shrink-0 text-muted-foreground" />
            </button>

            {/* Preferences — Appearance hosts the theme switcher. */}
            <Section label="Preferences">
                <Row
                    leading={<RowIcon icon={LinkIcon} />}
                    label="Connectors"
                    trailing={<Icon icon={ChevronRight} className="size-4 text-muted-foreground" />}
                    onClick={() => { void navigate("/settings/connectors"); }}
                />
                <Row
                    leading={<RowIcon icon={Bell} />}
                    label="Notifications"
                    trailing={<Icon icon={ChevronRight} className="size-4 text-muted-foreground" />}
                    onClick={() => { void navigate("/settings/notifications"); }}
                />
                <Row
                    leading={<RowIcon icon={PaintBrush} />}
                    label="Appearance"
                    trailing={<Icon icon={ChevronRight} className="size-4 text-muted-foreground" />}
                    onClick={() => { void navigate("/settings/appearance"); }}
                />
                <Row
                    leading={<RowIcon icon={PrivacyLock} />}
                    label="Privacy"
                    trailing={<Icon icon={ChevronRight} className="size-4 text-muted-foreground" />}
                    onClick={() => { void navigate("/settings/privacy"); }}
                    isLast
                />
            </Section>

            {/* Workspace switcher — keeps multi-org users reachable. Hidden until
                the orgs load and only shown when there's more than one to pick. */}
            {orgs.length > 0 && (
                <Section label={orgs.length > 1 ? "Switch workspace" : "Workspace"}>
                    {orgs.map((org, i) => {
                        const active = org.org_id === activeOrgId;
                        return (
                            <Row
                                key={org.org_id}
                                leading={<OrgMark org={org} />}
                                label={orgLabel(org)}
                                trailing={
                                    active ? (
                                        <Icon icon={Check} className="size-4 text-primary" />
                                    ) : undefined
                                }
                                onClick={() => { switchOrg(org.org_id); }}
                                isLast={i === orgs.length - 1}
                            />
                        );
                    })}
                </Section>
            )}

            <Section>
                <Row
                    leading={<RowIcon icon={LogOut} destructive />}
                    label="Sign out"
                    onClick={handleSignOut}
                    destructive
                    isLast
                />
            </Section>
        </div>
    );
}

function orgLabel(org: Org): string {
    const base = org.display_name ?? org.name;
    return org.is_personal ? `${base} (Personal)` : base;
}

/** Group label + a single rounded card whose rows are hairline-divided. */
function Section({ label, children }: { label?: string; children: ReactNode }) {
    return (
        <section>
            {label && (
                <h2 className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">{label}</h2>
            )}
            <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/50 bg-card">
                {children}
            </div>
        </section>
    );
}

/** A tinted leading glyph that lines up the row text in a consistent column. */
function RowIcon({ icon, destructive }: { icon: IconSvgElement; destructive?: boolean }) {
    return (
        <Icon
            icon={icon}
            className={cn("size-[19px]", destructive ? "text-destructive" : "text-muted-foreground")}
        />
    );
}

/** Square workspace monogram — mirrors the desktop OrgSwitcher mark. */
function OrgMark({ org }: { org: Org }) {
    return (
        <div
            aria-hidden="true"
            className="flex size-[26px] shrink-0 items-center justify-center rounded-md bg-foreground/10 text-[10px] font-semibold uppercase tracking-tight text-foreground"
        >
            {orgInitials(org)}
        </div>
    );
}

function orgInitials(org: Org): string {
    const raw = (org.display_name ?? org.name).trim();
    if (!raw) return "?";
    const words = raw.split(/\s+/).filter(Boolean);
    const initials =
        words.length >= 2 ? words.slice(0, 2).map(w => w.charAt(0)).join("") : raw.slice(0, 2);
    return initials.toUpperCase();
}

interface RowProps {
    leading: ReactNode;
    label: string;
    trailing?: ReactNode;
    onClick: () => void;
    isLast?: boolean;
    destructive?: boolean;
}

function Row({ leading, label, trailing, onClick, destructive }: RowProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition active:bg-foreground/5"
        >
            <span className="flex w-[26px] shrink-0 justify-center">{leading}</span>
            <span
                className={cn(
                    "min-w-0 flex-1 truncate text-sm font-medium",
                    destructive ? "text-destructive" : "text-foreground",
                )}
            >
                {label}
            </span>
            {trailing && <span className="flex shrink-0 items-center">{trailing}</span>}
        </button>
    );
}
