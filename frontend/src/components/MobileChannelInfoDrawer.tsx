import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/context/AuthContext";
import { getMmChannel } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg } from "@/lib/toast";
import { ChannelMemberRow } from "@/components/ChannelMemberRow";
import { memberKey, memberRowProps, useChannelMembers } from "@/hooks/useChannelMembers";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

/** The touch counterpart of ChatInfoSidebar: the channel's members as a bottom sheet, sharing its queries. */
export function MobileChannelInfoDrawer({ channelId, open, onOpenChange }: {
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { user } = useAuth();
  const { data: channel } = useQuery({
    queryKey: queryKeys.mm.channel(channelId),
    queryFn: () => getMmChannel(channelId),
    enabled: open,
  });
  const { query, members } = useChannelMembers(channelId, open);
  const total = query.data?.total ?? members.length;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Members</DrawerTitle>
          <p className="text-sm text-muted-foreground">
            {total === 1 ? "1 member" : `${String(total)} members`}
            {channel?.channel_type && (
              <span className="capitalize">{` · ${channel.channel_type}`}</span>
            )}
          </p>
        </DrawerHeader>

        <div className="flex flex-col pb-2">
          {query.isLoading && (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              Loading…
            </p>
          )}
          {query.isError && (
            <p className="px-1 py-6 text-center text-sm text-destructive">
              {errMsg(query.error, "Couldn't load members")}
            </p>
          )}
          {!query.isLoading && !query.isError && members.length === 0 && (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              No members yet.
            </p>
          )}
          {members.map((m) => (
            <ChannelMemberRow key={memberKey(m)} {...memberRowProps(m, user?.id)} />
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
