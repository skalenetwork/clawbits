import {NavLink, useLocation} from "react-router-dom";
import {
    UserMultiple02Icon as UserGroup,
    UserIcon as User,
    PaintBrush01Icon as PaintBrush,
    LockIcon as PrivacyLock,
    Notification03Icon as Bell,
    HashtagIcon as Hash,
    ChartHistogramIcon as UsageChart,
    Link01Icon as LinkIcon,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {ReefIcon} from "@/components/ReefIcon";
import {useActiveOrg} from "@/hooks/useActiveOrg";
import {SidebarMenuButton, SidebarMenuItem} from "@/components/ui/sidebar";
import {CollapsibleGroup} from "./CollapsibleGroup";
import {ContextualHeader} from "./ContextualHeader";

/**
 * The Settings contextual sidebar — Organization (owner-only) + Account.
 * Lifted verbatim from the old SidebarLayout "settings" mode.
 */
export function SettingsSidebar() {
    const location = useLocation();
    const pathname = location.pathname;
    // Gate the Organization group on the caller's role (reads ``my_role`` off
    // the active org — no extra fetch, no leaked member data for non-owners).
    const {isOwner: isOrgOwner} = useActiveOrg();

    return (
        <>
            <ContextualHeader title="Settings"/>
            <div data-vt-contextual="" className="no-scrollbar flex-1 overflow-y-auto p-1 pt-13">
                {isOrgOwner && (
                    <CollapsibleGroup id="organization-settings" label="Organization">
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                render={<NavLink to="/settings/members" viewTransition/>}
                                isActive={pathname === "/settings/members"}
                                tooltip="Members"
                            >
                                <Icon icon={UserGroup}/>
                                <span>Members</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                render={<NavLink to="/settings/usage" viewTransition/>}
                                isActive={pathname === "/settings/usage"}
                                tooltip="Usage"
                            >
                                <Icon icon={UsageChart}/>
                                <span>Usage</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                render={<NavLink to="/settings/channels" viewTransition/>}
                                isActive={pathname === "/settings/channels"}
                                tooltip="Channels"
                            >
                                <Icon icon={Hash}/>
                                <span>Channels</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                render={<NavLink to="/settings/reef" viewTransition/>}
                                isActive={pathname === "/settings/reef"}
                                tooltip="Reef"
                            >
                                <ReefIcon/>
                                <span>Reef</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </CollapsibleGroup>
                )}
                <CollapsibleGroup id="account" label="Account">
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            render={<NavLink to="/settings/profile" viewTransition/>}
                            isActive={pathname === "/settings/profile"}
                            tooltip="Profile"
                        >
                            <Icon icon={User}/>
                            <span>Profile</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            render={<NavLink to="/settings/connectors" viewTransition/>}
                            isActive={pathname === "/settings/connectors"}
                            tooltip="Connectors"
                        >
                            <Icon icon={LinkIcon}/>
                            <span>Connectors</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            render={<NavLink to="/settings/notifications" viewTransition/>}
                            isActive={pathname === "/settings/notifications"}
                            tooltip="Notifications"
                        >
                            <Icon icon={Bell}/>
                            <span>Notifications</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            render={<NavLink to="/settings/privacy" viewTransition/>}
                            isActive={pathname === "/settings/privacy"}
                            tooltip="Privacy"
                        >
                            <Icon icon={PrivacyLock}/>
                            <span>Privacy</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            render={<NavLink to="/settings/appearance" viewTransition/>}
                            isActive={pathname === "/settings/appearance"}
                            tooltip="Appearance"
                        >
                            <Icon icon={PaintBrush}/>
                            <span>Appearance</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </CollapsibleGroup>
            </div>
        </>
    );
}
