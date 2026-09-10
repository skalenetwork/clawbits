import { useState, type ComponentProps, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { ChannelGlyph } from "@/components/ChannelGlyph";
import { PresenceDot } from "@/components/PresenceDot";
import { useAgentStatus } from "@/hooks/useAgentPresence";
import { useUserStatus } from "@/hooks/useUserPresence";
import { MobileChatsScreen } from "@/components/MobileChatsScreen";
import { HomeTile, KEYCAP_CLASS, Squircle, SquircleDefs } from "@/components/home/tiles";
import { openCommandPalette } from "@/components/command/paletteStore";
import { openCreate } from "@/components/command/createStore";
import { useIsMobile } from "@/hooks/use-mobile";
import { useActiveOrg } from "@/hooks/useActiveOrg";
import { useAuth } from "@/context/AuthContext";
import { getAgents, getReef, listMmChannels, type AgentUser, type MmChannel } from "@/lib/api";
import { agentLivenessStatus } from "@/lib/agentLiveness";
import { frecencyKey, frecencyScore, loadFrecency } from "@/lib/frecency";
import { activityTime } from "@/lib/chatFilters";
import { usePushSubscription } from "@/lib/push";
import { queryKeys } from "@/lib/queryKeys";
import { formatChannelTitle } from "@/lib/formatting";
import { toast } from "@/lib/toast";

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

const unreadFirst = (c: MmChannel) => ((c.unread_count ?? 0) > 0 ? 0 : 1);

function unreadLabel(unread: number, idle: string): string {
  return unread > 0 ? `${String(unread)} new message${unread === 1 ? "" : "s"}` : idle;
}

export default function AgentHomePage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileChatsScreen /> : <DesktopHome />;
}

function DesktopHome() {
  const { activeOrgId } = useAuth();
  const { org, isOwner } = useActiveOrg();

  // Snapshotted per mount so the ranking cannot reshuffle under the cursor.
  const [frecency] = useState(() => loadFrecency());
  const [now] = useState(() => Date.now());

  const channelsQuery = useQuery({
    queryKey: queryKeys.mm.channels(activeOrgId ?? null),
    queryFn: () => listMmChannels(activeOrgId ?? null),
    enabled: Boolean(activeOrgId),
  });
  const channels = channelsQuery.data?.channels ?? [];

  // Connected is not finished: a repo with no host reporting cannot run
  // anything. One request, no polling, so home stays quiet.
  const reefQuery = useQuery({
    queryKey: activeOrgId ? queryKeys.reef(activeOrgId) : ["org", "none", "reef"],
    queryFn: () => getReef(activeOrgId ?? ""),
    enabled: Boolean(activeOrgId) && isOwner && Boolean(org?.reef_connected),
    staleTime: 60_000,
  });

  const agentsQuery = useQuery({
    queryKey: activeOrgId ? queryKeys.agents(activeOrgId) : ["agents", "none"],
    queryFn: () => getAgents(activeOrgId ?? ""),
    enabled: Boolean(activeOrgId),
  });

  // Contact is closed by default, so an org can hold agents that are not yours
  // to talk to and a tile pointing at one would be a dead end.
  const topAgent: AgentUser | null =
    (agentsQuery.data?.agents ?? [])
      .filter((a) => a.can_dm)
      .sort((a, b) => {
        const sa = frecencyScore(frecencyKey("agent", a.agent_id), frecency, now);
        const sb = frecencyScore(frecencyKey("agent", b.agent_id), frecency, now);
        return sa === sb ? (b.creation_time ?? "").localeCompare(a.creation_time ?? "") : sb - sa;
      })[0] ?? null;

  const topAgentDm = topAgent
    ? (channels.find(
        (c) => c.channel_type === "direct" && c.dm_peer_agent_id === topAgent.agent_id,
      ) ?? null)
    : null;

  // Unread first, recency inside each band, so a live thread beats a stale one
  // either way. The agent tile already owns its own DM.
  const topChannels = channels
    .filter((c) => c.channel_id !== topAgentDm?.channel_id)
    .sort((a, b) => unreadFirst(a) - unreadFirst(b) || activityTime(b) - activityTime(a))
    .slice(0, 2);
  const nextShortcut = isOwner ? 3 : 2;

  return (
    <>
      <SquircleDefs />

      <div className="flex flex-1 flex-col justify-center px-2 py-10 sm:px-4">
        <div className="home-tiles mx-auto grid w-full max-w-2xl grid-cols-4 gap-2.5">
          <SearchTile />
          {isOwner && (
            <ReefTile
              connected={Boolean(org?.reef_connected)}
              hosts={reefQuery.data?.hosts.length ?? null}
              shortcut={1}
            />
          )}
          <AgentTile
            agent={topAgent}
            dm={topAgentDm}
            shortcut={isOwner ? 2 : 1}
            className={isOwner ? "col-span-2" : "col-span-4"}
          />
          {topChannels.length === 0 ? (
            <ConversationTile channel={null} shortcut={nextShortcut} />
          ) : (
            topChannels.map((c, i) => (
              <ConversationTile key={c.channel_id} channel={c} shortcut={nextShortcut + i} />
            ))
          )}
          <HomeNudges shortcut={nextShortcut + Math.max(topChannels.length, 1)} />
        </div>
      </div>
    </>
  );
}

/** Three states, not two: a repo with no host reporting is half-finished, and
 *  that person belongs back in the flow rather than on a page reading
 *  "Connected". ``hosts`` is null until known. */
function ReefTile({
  connected,
  hosts,
  shortcut,
}: {
  connected: boolean;
  hosts: number | null;
  shortcut: number;
}) {
  const unfinished = connected && hosts === 0;
  return (
    <HomeTile
      className="col-span-2"
      shortcut={shortcut}
      to={connected && !unfinished ? "/settings/reef" : "/setup/reef"}
      glyph={<AppIcon src="/reef-light.webp" dark="/reef-dark.webp" />}
      label={!connected ? "Set up Reef" : unfinished ? "Finish setting up Reef" : "Manage Reef"}
      value={
        !connected
          ? "Connect now"
          : unfinished
            ? "Add a machine"
            : hosts === null
              ? "Connected"
              : `${String(hosts)} machine${hosts === 1 ? "" : "s"}`
      }
    />
  );
}

/** A native Icon Composer asset: it ships its own squircle and its own depth,
 *  so it is rendered bare. Our glass on top of one reads as a smudge. */
function AppIcon({ src, dark }: { src: string; dark?: string }) {
  if (!dark) return <img src={src} alt="" className="size-[42px]" width={42} height={42} />;
  return (
    <>
      <img src={src} alt="" className="size-[42px] dark:hidden" width={42} height={42} />
      <img src={dark} alt="" className="hidden size-[42px] dark:block" width={42} height={42} />
    </>
  );
}

/** Flat art takes the glass squircle; presence is drawn outside the clip so it
 *  is not sliced by it. */
function TileGlyph({
  status,
  children,
}: {
  status?: ComponentProps<typeof PresenceDot>["status"];
  children: ReactNode;
}) {
  return (
    <>
      <Squircle className="bg-muted">{children}</Squircle>
      {status && (
        <PresenceDot status={status} className="absolute -right-px -bottom-px ring-2 ring-card" />
      )}
    </>
  );
}

/** ``dm`` is the conversation you already have with them: jump back should land
 *  in it rather than on a profile. */
function AgentTile({
  agent,
  dm,
  shortcut,
  className,
}: {
  agent: AgentUser | null;
  dm: MmChannel | null;
  shortcut: number;
  className: string;
}) {
  if (!agent) {
    return (
      <HomeTile
        className={className}
        shortcut={shortcut}
        onClick={() => {
          openCreate("agent");
        }}
        glyph={<AppIcon src="/plus.webp" />}
        label="Set up your agent"
        value="Create"
      />
    );
  }
  const name = agent.display_name || agent.nickname || agent.agent_id;
  return (
    <HomeTile
      className={className}
      shortcut={shortcut}
      to={dm ? `/channels/${dm.channel_id}` : `/agents/${agent.agent_id}`}
      glyph={
        <TileGlyph status={agentLivenessStatus(agent.last_alive_at ?? null)}>
          <AgentFaceAvatar
            name={name}
            src={agent.avatar?.url}
            size={42}
            framed={false}
            className="rounded-none"
          />
        </TileGlyph>
      }
      label={unreadLabel(dm?.unread_count ?? 0, dm ? "Work with" : "Open")}
      value={name}
    />
  );
}

function ConversationTile({
  channel,
  shortcut,
}: {
  channel: MmChannel | null;
  shortcut: number;
}) {
  // Both hooks answer "offline" for a null id, so they run unconditionally.
  const peerStatus = useUserStatus(channel?.dm_peer_human_id ?? null);
  const agentStatus = useAgentStatus(channel?.dm_peer_agent_id ?? null);

  if (!channel) {
    return (
      <HomeTile
        className="col-span-2"
        shortcut={shortcut}
        onClick={() => {
          openCreate("dm");
        }}
        glyph={<AppIcon src="/channels.webp" />}
        label="Start a conversation"
        value="New chat"
      />
    );
  }

  const isDm = channel.channel_type === "direct";
  return (
    <HomeTile
      className="col-span-2"
      shortcut={shortcut}
      to={`/channels/${channel.channel_id}`}
      glyph={
        <TileGlyph
          status={
            channel.dm_peer_agent_id
              ? agentStatus
              : channel.dm_peer_human_id
                ? peerStatus
                : undefined
          }
        >
          <ChannelGlyph
            channel={channel}
            size={42}
            showPresenceDot={false}
            className="rounded-none"
          />
        </TileGlyph>
      }
      label={unreadLabel(channel.unread_count ?? 0, isDm ? "Open DM" : "Open channel")}
      value={formatChannelTitle(
        channel.display_name ?? channel.name,
        isDm ? "Direct message" : "Channel",
      )}
    />
  );
}

/** Not a search box: the palette reaches six groups and seven actions, so
 *  "find or do" is the honest pair of verbs. */
function SearchTile() {
  return (
    <HomeTile
      className="col-span-4"
      onClick={() => {
        openCommandPalette();
      }}
      glyph={<AppIcon src="/cmd.webp" />}
      label="Agents, chats and actions"
      value="Find or do anything"
      trailing={
        <span className="flex gap-[3px]">
          {[IS_MAC ? "⌘" : "Ctrl", "K"].map((k) => (
            <kbd key={k} className={KEYCAP_CLASS}>
              {k}
            </kbd>
          ))}
        </span>
      }
    />
  );
}

/** Renders nothing once notifications are on (or unsupported), so a settled
 *  workspace keeps its two rows. Blocked at the browser is a report, not a
 *  control: with no onClick the tile stops being pressable. */
function HomeNudges({ shortcut }: { shortcut: number }) {
  const push = usePushSubscription();
  if (push.status !== "prompt" && push.status !== "denied") return null;

  const denied = push.status === "denied";
  const enable = async () => {
    const result = await push.enable();
    if (result === "enabled") toast.success("Notifications enabled");
    else if (result === "denied")
      toast.error("Notifications were blocked, allow them in your browser settings");
    else if (result === "unavailable")
      toast.error("Push notifications aren't available right now");
  };

  return (
    <HomeTile
      className="col-span-4"
      shortcut={shortcut}
      onClick={
        denied
          ? undefined
          : () => {
              void enable();
            }
      }
      glyph={<AppIcon src="/notifications.webp" />}
      label={denied ? "Notifications are blocked" : "New messages and mentions"}
      value={denied ? "Enable them in your browser settings" : "Turn on notifications"}
    />
  );
}
