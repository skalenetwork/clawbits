import { Navigate, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
    ArrowRight01Icon as ChevronRight,
    BookOpen01Icon,
    Link01Icon as LinkIcon,
    LockIcon as PrivacyLock,
    Logout01Icon as LogOut,
    Notification03Icon as Bell,
    PaintBrush01Icon as PaintBrush,
    Settings01Icon as SettingsIcon,
    Tick01Icon as Check,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { UserAvatar } from "@/components/UserAvatar";
import { PageHeader } from "@/components/PageHeader";
import { SettingsPage, SettingsRow, SettingsSection } from "@/components/settings/Settings";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/context/AuthContext";
import { useOpenOrg } from "@/hooks/useOpenOrg";
import { getOrgs, type Org } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const CHEVRON = <Icon icon={ChevronRight} className="size-4 text-muted-foreground" />;

const PREFERENCES: { icon: IconSvgElement; title: string; to: string }[] = [
    { icon: LinkIcon, title: "Connectors", to: "/settings/connectors" },
    { icon: Bell, title: "Notifications", to: "/settings/notifications" },
    { icon: PaintBrush, title: "Appearance", to: "/settings/appearance" },
    { icon: PrivacyLock, title: "Privacy", to: "/settings/privacy" },
];

/** The mobile "You" tab index: the mobile shell has no SettingsSidebar, so this
 *  is the only way to reach the settings sub-pages and switch workspace there. */
export default function SettingsMenuPage() {
    const isMobile = useIsMobile();
    const navigate = useNavigate();
    const { user, activeOrgId, logout } = useAuth();
    const openOrg = useOpenOrg();

    const orgsQuery = useQuery({
        queryKey: queryKeys.orgs,
        queryFn: () => getOrgs(),
        staleTime: 60_000,
    });
    const orgs = orgsQuery.data?.organizations ?? [];

    if (!isMobile) return <Navigate to="/settings/profile" replace />;

    const name = user?.display_name ?? user?.email ?? "Your profile";

    const switchOrg = (orgId: string) => {
        if (orgId === activeOrgId) return;
        openOrg(orgId);
    };

    const handleSignOut = () => {
        void logout().then(() => navigate("/login"));
    };

    return (
        <div>
            <PageHeader icon={SettingsIcon} title="Settings" />

            <SettingsPage>
                <SettingsSection>
                    <SettingsRow
                        leading={<UserAvatar size={44} name={name} src={user?.avatar?.url} />}
                        title={name}
                        description={user?.email}
                        control={CHEVRON}
                        onClick={() => { void navigate("/settings/profile"); }}
                    />
                </SettingsSection>

                <SettingsSection label="Library">
                    <SettingsRow
                        leading={<RowIcon icon={BookOpen01Icon} />}
                        title="Skills"
                        control={CHEVRON}
                        onClick={() => { void navigate("/skills"); }}
                    />
                </SettingsSection>

                <SettingsSection label="Preferences">
                    {PREFERENCES.map(p => (
                        <SettingsRow
                            key={p.to}
                            leading={<RowIcon icon={p.icon} />}
                            title={p.title}
                            control={CHEVRON}
                            onClick={() => { void navigate(p.to); }}
                        />
                    ))}
                </SettingsSection>

                {orgs.length > 0 && (
                    <SettingsSection label={orgs.length > 1 ? "Switch workspace" : "Workspace"}>
                        {orgs.map(org => (
                            <SettingsRow
                                key={org.org_id}
                                leading={<Avatar src={org.avatar?.url} name={org.display_name ?? org.name} size={26} className="rounded-md" />}
                                title={orgLabel(org)}
                                control={
                                    org.org_id === activeOrgId
                                        ? <Icon icon={Check} className="size-4 text-primary" />
                                        : undefined
                                }
                                onClick={() => { switchOrg(org.org_id); }}
                            />
                        ))}
                    </SettingsSection>
                )}

                <SettingsSection>
                    <SettingsRow
                        leading={<Icon icon={LogOut} className="size-[19px] text-destructive" />}
                        title={<span className="text-destructive">Sign out</span>}
                        onClick={handleSignOut}
                    />
                </SettingsSection>
            </SettingsPage>
        </div>
    );
}

function orgLabel(org: Org): string {
    const base = org.display_name ?? org.name;
    return org.is_personal ? `${base} (Personal)` : base;
}

function RowIcon({ icon }: { icon: IconSvgElement }) {
    return <Icon icon={icon} className="size-[19px] text-muted-foreground" />;
}

