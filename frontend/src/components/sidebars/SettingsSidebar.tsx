import type {ReactNode} from "react";
import {NavLink, useLocation} from "react-router-dom";
import {
    ChartHistogramIcon as UsageChart,
    HashtagIcon as Hash,
    Link01Icon as LinkIcon,
    LockIcon as PrivacyLock,
    Megaphone01Icon as Megaphone,
    Notification03Icon as Bell,
    PaintBrush01Icon as PaintBrush,
    UserIcon as User,
    UserMultiple02Icon as UserGroup,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {ReefIcon} from "@/components/ReefIcon";
import {useActiveOrg} from "@/hooks/useActiveOrg";
import {SidebarMenu, SidebarMenuButton, SidebarMenuItem} from "@/components/ui/sidebar";

interface SettingsLink {
    to: string;
    label: string;
    icon: ReactNode;
}

const ORGANIZATION: SettingsLink[] = [
    {to: "/settings/members", label: "Members", icon: <Icon icon={UserGroup}/>},
    {to: "/settings/usage", label: "Usage", icon: <Icon icon={UsageChart}/>},
    {to: "/settings/channels", label: "Channels", icon: <Icon icon={Hash}/>},
    {to: "/settings/lobstertalk", label: "LobsterTalk", icon: <Icon icon={Megaphone}/>},
    {to: "/settings/reef", label: "Reef", icon: <ReefIcon/>},
];

const ACCOUNT: SettingsLink[] = [
    {to: "/settings/profile", label: "Profile", icon: <Icon icon={User}/>},
    {to: "/settings/connectors", label: "Connectors", icon: <Icon icon={LinkIcon}/>},
    {to: "/settings/notifications", label: "Notifications", icon: <Icon icon={Bell}/>},
    {to: "/settings/privacy", label: "Privacy", icon: <Icon icon={PrivacyLock}/>},
    {to: "/settings/appearance", label: "Appearance", icon: <Icon icon={PaintBrush}/>},
];

/** Settings replaces the main sidebar: the Organization links (owners only)
 *  and the Account links. Back sits in the footer. */
export function SettingsSidebar() {
    const {pathname} = useLocation();
    const {isOwner} = useActiveOrg();
    return (
        <div className="flex flex-col gap-4 pt-2">
            {isOwner && <Group label="Organization" links={ORGANIZATION} pathname={pathname}/>}
            <Group label="Account" links={ACCOUNT} pathname={pathname}/>
        </div>
    );
}

function Group({label, links, pathname}: {label: string; links: SettingsLink[]; pathname: string}) {
    return (
        <div>
            <p className="flex h-7 items-center px-2 text-[13px] font-medium text-muted-foreground">{label}</p>
            <SidebarMenu>
                {links.map((l) => (
                    <SidebarMenuItem key={l.to}>
                        <SidebarMenuButton render={<NavLink to={l.to} viewTransition/>} isActive={pathname === l.to}>
                            {l.icon}
                            <span>{l.label}</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                ))}
            </SidebarMenu>
        </div>
    );
}
