import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Search01Icon as Search,
  Home03Icon as HomeIcon,
  Robot02Icon as Bot,
  UserAdd01Icon as InvitePeople,
  Notification03Icon as Bell,
  Calendar01Icon,
  InboxUnreadIcon,
  MessageMultiple01Icon,
  CheckmarkCircle04Icon,
  Attachment01Icon as Paperclip,
} from "@hugeicons/core-free-icons";
import { ChannelGlyph } from "@/components/ChannelGlyph";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { MobileChatsScreen } from "@/components/MobileChatsScreen";
import { openCommandPalette } from "@/components/command/paletteStore";
import { openCreate } from "@/components/command/createStore";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/context/AuthContext";
import { getAgents, listMmChannels, listOrgMembers } from "@/lib/api";
import { loadFrecency } from "@/lib/frecency";
import { rankJumpBackIn } from "@/lib/jumpBackIn";
import { useMessageDrafts } from "@/hooks/useMessageDrafts";
import { usePushSubscription } from "@/lib/push";
import { queryKeys } from "@/lib/queryKeys";
import {
  formatChannelTitle,
  getTimeOfDayGreeting,
  formatLongDate,
} from "@/lib/formatting";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Stagger } from "@/components/agent/manage/Stagger";

/** Mac shows a ⌘ glyph in the command-bar hint; everything else shows "Ctrl". */
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The Chats tab branches by viewport: a clean conversation list on mobile,
 *  the home launchpad on desktop. ``DesktopHome`` is a hoisted declaration, so
 *  referencing it above its definition is fine. */
export default function AgentHomePage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileChatsScreen /> : <DesktopHome />;
}

function DesktopHome() {
  const { user, activeOrgId } = useAuth();
  const navigate = useNavigate();

  // Snapshot frecency + "now" once per mount so the recents ranking stays
  // stable across re-renders and the memo below stays pure (no Date.now()).
  const [frecency] = useState(() => loadFrecency());
  const [now] = useState(() => Date.now());

  const channelsQuery = useQuery({
    queryKey: queryKeys.mm.channels(activeOrgId ?? null),
    queryFn: () => listMmChannels(activeOrgId ?? null),
    enabled: Boolean(activeOrgId),
  });
  const channels = useMemo(
    () => channelsQuery.data?.channels ?? [],
    [channelsQuery.data],
  );

  const agentsQuery = useQuery({
    queryKey: activeOrgId ? queryKeys.agents(activeOrgId) : ["agents", "none"],
    queryFn: () => getAgents(activeOrgId ?? ""),
    enabled: Boolean(activeOrgId),
  });
  const agents = useMemo(
    () => agentsQuery.data?.agents ?? [],
    [agentsQuery.data],
  );

  const membersQuery = useQuery({
    queryKey: activeOrgId
      ? queryKeys.orgMembers(activeOrgId)
      : ["org-members", "none"],
    queryFn: () => listOrgMembers(activeOrgId ?? ""),
    enabled: Boolean(activeOrgId),
  });
  const otherMembersCount = (membersQuery.data?.members ?? []).filter(
    (m) => m.human_id !== user?.id,
  ).length;

  // "Jump back in" — top 4 conversations to resume, ranked by habit
  // (frecency) + recency, then boosted for what wants attention now: an
  // unsent draft, or unread that came *in* to you (agent replies, DMs). See
  // lib/jumpBackIn.ts. Drafts are local to this device, hence the live map.
  const drafts = useMessageDrafts(user?.id);
  const recents = useMemo(
    () =>
      rankJumpBackIn({
        channels,
        frecency,
        drafts,
        now,
        currentUserId: user?.id,
      }),
    [channels, frecency, drafts, now, user?.id],
  );

  const unreadTotal = channels.reduce((n, c) => n + (c.unread_count ?? 0), 0);
  const unreadConvos = channels.filter((c) => (c.unread_count ?? 0) > 0).length;

  const hasAnyAgent = agents.length > 0;
  const settled = !agentsQuery.isLoading && !membersQuery.isLoading;
  // Empty org: no other humans AND no agents. Only "grow the org" actions are
  // useful — channels/DMs need someone to chat with. Gate on settled queries
  // so the first-run state doesn't flash before data loads.
  const isEmptyOrg = settled && otherMembersCount === 0 && !hasAnyAgent;

  const firstName = user?.display_name?.split(" ")[0] ?? "there";
  const subline: ReactNode = isEmptyOrg ? (
    "Let's get your workspace set up"
  ) : (
    <>
      <Icon icon={Calendar01Icon} className="size-3.5 shrink-0" />
      <span>{formatLongDate()}</span>
      <span aria-hidden="true" className="opacity-40">
        ·
      </span>
      {unreadTotal > 0 ? (
        <>
          <Icon icon={InboxUnreadIcon} className="size-3.5 shrink-0" />
          <span>{unreadTotal} unread in</span>
          <Icon icon={MessageMultiple01Icon} className="size-3.5 shrink-0" />
          <span>
            {unreadConvos} conversation{unreadConvos === 1 ? "" : "s"}
          </span>
        </>
      ) : (
        <>
          <Icon icon={CheckmarkCircle04Icon} className="size-3.5 shrink-0" />
          <span>{"You're all caught up"}</span>
        </>
      )}
    </>
  );

  return (
    <>
      <PageHeader icon={HomeIcon} title="Home" />

      {/* Fill the content area and vertically center the launchpad. The
                shell wrapper is a min-h-full flex column, so ``flex-1`` here
                grabs the height and ``m-auto`` on the inner column centres it
                (degrading to top-aligned if it ever overflows). */}
      <div className="flex flex-1 flex-col justify-center px-2 py-10 sm:px-4">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
          {/* Greeting — the one editorial moment: a large serif welcome. */}
          <Stagger delay={0}>
            <h1 className="font-serif text-3xl font-medium tracking-tight text-foreground sm:text-4xl">
              {getTimeOfDayGreeting()}, {firstName}
            </h1>
            <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground">
              {subline}
            </p>
          </Stagger>

          {/* Command bar — the single universal entry point (opens ⌘K). */}
          <Stagger delay={60}>
            <button
              type="button"
              onClick={() => {
                openCommandPalette();
              }}
              aria-label="Search or jump to anything"
              className="group flex h-12 w-full items-center gap-3 rounded-2xl border border-border/70 bg-card px-3 text-left shadow-xs transition duration-150 hover:border-border hover:bg-muted/30 active:scale-[0.99] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
            >
              <Icon
                icon={Search}
                className="size-[18px] shrink-0 text-muted-foreground"
              />
              <span className="flex-1 truncate text-sm text-muted-foreground">
                Search or jump to anything…
              </span>
              <kbd className="inline-flex h-7 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-background px-2.5 font-mono text-xs font-medium text-muted-foreground shadow-xs transition-colors group-hover:border-border group-hover:text-foreground">
                {IS_MAC ? (
                  <>
                    <span className="mr-0.5 text-[15px] leading-none">⌘</span>
                    K
                  </>
                ) : (
                  "Ctrl K"
                )}
              </kbd>
            </button>
          </Stagger>

          {/* Jump back in — compact recents; hidden when there are none. */}
          {!isEmptyOrg && (channelsQuery.isLoading || recents.length > 0) && (
            <Stagger delay={120} className="space-y-3">
              <h2 className="text-sm text-muted-foreground">Jump back in</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {channelsQuery.isLoading
                  ? Array.from({ length: 4 }).map((_, i) => (
                      <div
                        key={i}
                        className="rounded-xl border border-border/60 bg-card p-3"
                      >
                        <div className="size-8 animate-pulse rounded-lg bg-muted" />
                        <div className="mt-3 h-3.5 w-2/3 animate-pulse rounded bg-muted" />
                        <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-muted" />
                      </div>
                    ))
                  : recents.map(({ channel: c, reason, draftText }) => {
                      const label = formatChannelTitle(
                        c.display_name ?? c.name,
                        c.channel_type === "direct"
                          ? "Direct message"
                          : "Channel",
                      );
                      const lastText = c.last_message_text?.trim() ?? "";
                      const attachmentCount =
                        c.last_message_attachment_count ?? 0;
                      const unread = c.unread_count ?? 0;
                      const muted = Boolean(c.muted);
                      return (
                        <Link
                          key={c.channel_id}
                          to={`/channels/${c.channel_id}`}
                          className="group flex flex-col gap-2 rounded-xl border border-border/60 bg-card p-3 transition duration-150 ease-out hover:border-border hover:bg-muted/40 active:scale-[0.97] active:duration-75"
                        >
                          <span className="relative inline-flex">
                            <ChannelGlyph channel={c} size={32} />
                            {unread > 0 && (
                              <span
                                className={cn(
                                  "absolute -right-1.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none tabular-nums ring-2 ring-card",
                                  muted
                                    ? "bg-muted text-muted-foreground"
                                    : "bg-primary text-primary-foreground",
                                )}
                                aria-label={`${String(unread)} unread message${unread === 1 ? "" : "s"}`}
                              >
                                {unread > 99 ? "99+" : unread}
                              </span>
                            )}
                          </span>
                          <span className="min-w-0">
                            <span
                              className={cn(
                                "block truncate text-sm",
                                unread > 0 && !muted
                                  ? "font-semibold"
                                  : "font-medium",
                              )}
                            >
                              {label}
                            </span>
                            {/* An unsent draft wins over the last-message preview
                                                      (the Telegram/sidebar pattern), since that's why the
                                                      card surfaced. */}
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {reason === "draft" && draftText ? (
                                <>
                                  <span className="font-medium text-destructive">
                                    Draft:
                                  </span>{" "}
                                  {draftText}
                                </>
                              ) : lastText ? (
                                lastText
                              ) : attachmentCount > 0 ? (
                                // Attachment-only last message — mirror the sidebar's
                                // paperclip + count instead of reading as empty.
                                <span className="inline-flex items-center gap-1 align-middle">
                                  <Icon
                                    icon={Paperclip}
                                    className="size-2.5! shrink-0 opacity-70"
                                  />
                                  {attachmentCount === 1
                                    ? "Attachment"
                                    : `${String(attachmentCount)} attachments`}
                                </span>
                              ) : (
                                "No messages yet"
                              )}
                            </span>
                          </span>
                        </Link>
                      );
                    })}
              </div>
            </Stagger>
          )}

          {/* First-run only: a focused pair of CTAs to grow an empty org.
                    Populated orgs use ⌘K (and the rail) for these actions. */}
          {isEmptyOrg && (
            <Stagger delay={180}>
              <div className="flex flex-wrap items-center gap-2.5">
                <Button
                  onClick={() => {
                    openCreate("agent");
                  }}
                >
                  <Icon icon={Bot} className="size-4" />
                  Add your first agent
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    void navigate("/settings/members");
                  }}
                >
                  <Icon icon={InvitePeople} className="size-4" />
                  Invite people
                </Button>
              </div>
            </Stagger>
          )}

          {/* Notification opt-in — a single quiet row, only when actionable. */}
          {!isEmptyOrg && (
            <Stagger delay={240}>
              <HomeNudges />
            </Stagger>
          )}
        </div>
      </div>
    </>
  );
}

/** Notification opt-in nudge — a single quiet row. Renders nothing once
 *  notifications are enabled (or unsupported), so the page's rhythm stays
 *  intact. */
function HomeNudges() {
  const push = usePushSubscription();
  const showPush = push.status === "prompt" || push.status === "denied";
  if (!showPush) return null;

  const denied = push.status === "denied";
  const enablePush = async () => {
    const result = await push.enable();
    if (result === "enabled") toast.success("Notifications enabled");
    else if (result === "denied")
      toast.error(
        "Notifications were blocked - allow them in your browser settings",
      );
    else if (result === "unavailable")
      toast.error("Push notifications aren't available right now");
  };

  return (
    <div className="divide-y divide-border/50 overflow-hidden rounded-2xl bg-muted/30">
      <SetupRow
        icon={Bell}
        label={
          denied
            ? "Notifications are blocked - enable them in your browser settings"
            : "Turn on notifications for new messages and mentions"
        }
        action={
          denied ? null : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void enablePush();
              }}
            >
              Enable
            </Button>
          )
        }
      />
    </div>
  );
}

/** One quiet setup row: a muted line icon, a single concise line, and an
 *  optional trailing action. The rows share one soft surface (divided by
 *  hairlines) rather than each being a separate alert card. */
function SetupRow({
  icon,
  label,
  action,
}: {
  icon: typeof Bell;
  label: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-2 pl-4 pr-2">
      <Icon icon={icon} className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-sm text-foreground">{label}</span>
      {action}
    </div>
  );
}
