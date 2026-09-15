import {NavLink, useLocation} from "react-router-dom";
import {
    Building03Icon,
    ChartHistogramIcon,
    HashtagIcon,
    Link01Icon,
    LockIcon,
    Megaphone01Icon,
    Notification03Icon,
    PaintBrush01Icon,
    UserIcon,
    UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {ReefIcon} from "@/components/ReefIcon";
import {SIDEBAR_SCROLL} from "@/components/ProgressiveBlur";
import {useActiveOrg} from "@/hooks/useActiveOrg";
import {SidebarMenu, SidebarMenuButton, SidebarMenuItem} from "@/components/ui/sidebar";
import {cn} from "@/lib/utils";

const GROUPS = [
    {
        label: "Organization",
        ownersOnly: true,
        links: [
            {to: "/settings/organization", label: "General", icon: <Icon icon={Building03Icon}/>},
            {to: "/settings/members", label: "Members", icon: <Icon icon={UserMultiple02Icon}/>},
            {to: "/settings/usage", label: "Usage", icon: <Icon icon={ChartHistogramIcon}/>},
            {to: "/settings/channels", label: "Channels", icon: <Icon icon={HashtagIcon}/>},
            {to: "/settings/lobstertalk", label: "LobsterTalk", icon: <Icon icon={Megaphone01Icon}/>},
            {to: "/settings/reef", label: "Reef", icon: <ReefIcon/>},
        ],
    },
    {
        label: "Account",
        ownersOnly: false,
        links: [
            {to: "/settings/profile", label: "Profile", icon: <Icon icon={UserIcon}/>},
            {to: "/settings/connectors", label: "Connectors", icon: <Icon icon={Link01Icon}/>},
            {to: "/settings/notifications", label: "Notifications", icon: <Icon icon={Notification03Icon}/>},
            {to: "/settings/privacy", label: "Privacy", icon: <Icon icon={LockIcon}/>},
            {to: "/settings/appearance", label: "Appearance", icon: <Icon icon={PaintBrush01Icon}/>},
        ],
    },
];

/** Replaces the main sidebar in Settings; Back sits in the shell's footer. */
export function SettingsSidebar() {
    const {pathname} = useLocation();
    const {isOwner} = useActiveOrg();
    return (
        <div className={cn(SIDEBAR_SCROLL, "flex flex-col gap-4")}>
            {GROUPS.filter((group) => isOwner || !group.ownersOnly).map((group) => (
                <div key={group.label}>
                    <p className="flex h-7 items-center px-2 text-[13px] font-medium text-muted-foreground">{group.label}</p>
                    <SidebarMenu>
                        {group.links.map((link) => (
                            <SidebarMenuItem key={link.to}>
                                <SidebarMenuButton render={<NavLink to={link.to} viewTransition/>} isActive={pathname === link.to}>
                                    {link.icon}
                                    <span>{link.label}</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        ))}
                    </SidebarMenu>
                </div>
            ))}
        </div>
    );
}
