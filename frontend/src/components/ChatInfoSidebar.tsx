import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Users } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useChannelActions } from "@/hooks/useChannelActions";
import { memberKey, memberRowProps, useChannelMembers } from "@/hooks/useChannelMembers";
import { getMmChannel, type MmChannelMember } from "@/lib/api";
import { formatChannelTitle } from "@/lib/formatting";
import { isPairChannel } from "@/lib/chatFilters";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg } from "@/lib/toast";
import { ChannelMemberRow } from "./ChannelMemberRow";
import ManageMembersDialog from "./ManageMembersDialog";
import { ProfileMenuProvider } from "@/components/ProfileMenu";
import { useProfileMenuTrigger } from "@/components/profileMenuContext";
import { mentionHandle } from "@/lib/messageHelpers";
import { PanelNote, RightPanel } from "@/components/sidebars/RightPanel";
import { CollapsibleGroup } from "@/components/sidebars/CollapsibleGroup";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

function MemberRowTrigger({ member, selfId }: { member: MmChannelMember; selfId: number | undefined }) {
  const onClick = useProfileMenuTrigger(member, `@${mentionHandle(member)}`);
  return <ChannelMemberRow {...memberRowProps(member, selfId)} onClick={onClick} />;
}

export default function ChatInfoSidebar({ channelId, open, onClose }: {
  channelId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const [manageOpen, setManageOpen] = useState(false);
  const channelActions = useChannelActions();

  const { data: channel } = useQuery({
    queryKey: queryKeys.mm.channel(channelId),
    queryFn: () => getMmChannel(channelId),
  });
  const { query: membersQuery, members } = useChannelMembers(channelId);
  const orgId = channel?.org_id ?? null;
  const canManage = channel != null && !isPairChannel(channel) && orgId !== null;

  // Its own provider: this panel sits beside the routed page, outside ChannelPage's, and has no composer.
  return (
    <ProfileMenuProvider
      orgId={orgId}
      currentUserId={user?.id ?? null}
    >
      <RightPanel
        open={open}
        title="Channel info"
        meta={channel?.channel_type && (
          <span className="shrink-0 rounded-full bg-foreground/6 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground capitalize">
            {channel.channel_type}
          </span>
        )}
        onClose={onClose}
        footer={channel && (
          <SidebarMenu>
            {canManage && (
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => { setManageOpen(true); }} className="text-muted-foreground">
                  <Users/>
                  <span>Manage members</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => { channelActions.exportChat(channel); }} className="text-muted-foreground">
                <Download/>
                <span>Export chat</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      >
        {membersQuery.isLoading && <PanelNote>Loading…</PanelNote>}
        {membersQuery.isError && <PanelNote error>{errMsg(membersQuery.error, "Couldn't load members")}</PanelNote>}
        {!membersQuery.isLoading && !membersQuery.isError && members.length === 0 && (
          <PanelNote>No members yet.</PanelNote>
        )}
        {members.length > 0 && (
          <CollapsibleGroup id="channel_members" label="Members">
            {members.map((m) => (
              <SidebarMenuItem key={memberKey(m)}>
                <MemberRowTrigger member={m} selfId={user?.id}/>
              </SidebarMenuItem>
            ))}
          </CollapsibleGroup>
        )}
      </RightPanel>

      {canManage && orgId && (
        <ManageMembersDialog
          open={manageOpen}
          onOpenChange={setManageOpen}
          channelId={channelId}
          orgId={orgId}
          channelLabel={formatChannelTitle(channel?.display_name ?? channel?.name, "channel")}
        />
      )}
    </ProfileMenuProvider>
  );
}
