import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChessPawn, Download, Users } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useChannelActions } from "@/hooks/useChannelActions";
import { memberKey, memberRowProps, useChannelMembers } from "@/hooks/useChannelMembers";
import { getMmChannel, getOrgs, setChannelWidgets, type MmChannelMember } from "@/lib/api";
import { formatChannelTitle } from "@/lib/formatting";
import { isPairChannel } from "@/lib/chatFilters";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { isWidgetChat } from "@/lib/widgets";
import { ChannelMemberRow } from "./ChannelMemberRow";
import ManageMembersDialog from "./ManageMembersDialog";
import { ProfileMenuProvider } from "@/components/ProfileMenu";
import { useProfileMenuTrigger } from "@/components/profileMenuContext";
import { mentionHandle } from "@/lib/messageHelpers";
import { PanelNote, RightPanel } from "@/components/sidebars/RightPanel";
import { CollapsibleGroup } from "@/components/sidebars/CollapsibleGroup";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";

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
  const queryClient = useQueryClient();
  const { data: orgs } = useQuery({ queryKey: queryKeys.orgs, queryFn: () => getOrgs(), staleTime: 60_000 });
  const orgWidgets = orgs?.organizations.find((o) => o.org_id === orgId)?.widgets_enabled ?? false;
  const widgets = useMutation({
    mutationFn: (enabled: boolean) => setChannelWidgets(channelId, enabled),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.mm.channel(channelId), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
    },
    onError: (e) => { toast.error(errMsg(e, "Couldn't change widgets")); },
  });

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
            {isWidgetChat(channel) && (
              <SidebarMenuItem>
                <label
                  title={orgWidgets ? undefined : "Turned off for this organization"}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground [&>svg]:size-4 [&>svg]:shrink-0"
                >
                  <ChessPawn/>
                  <span className="flex-1">Widgets</span>
                  <Switch
                    size="sm"
                    aria-label="Allow widgets like chess in this chat"
                    checked={Boolean(channel.widgets_enabled)}
                    disabled={widgets.isPending || (!orgWidgets && !channel.widgets_enabled)}
                    onCheckedChange={(next) => { widgets.mutate(next); }}
                  />
                </label>
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
