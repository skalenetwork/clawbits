// Click-triggered profile card for humans and agents.
//
// Architecture — single shared popover per page:
//   - ``ProfileMenuProvider`` mounts ONE base-ui Popover instance and
//     holds the current target (clicked member + anchor element).
//   - ``useProfileMenuTrigger(member, handleText)`` returns a click
//     handler. Components wrap their avatar / author-name / inline
//     mention in a plain button that calls this handler.
//   - When a trigger fires, the provider sets state and the single
//     Popover positions itself against the clicked element.
//
// Why shared: an earlier per-trigger version mounted PopoverPrimitive.Root
// for every avatar, author name, and inline @mention — at 100+ instances
// the FloatingTree contexts and useSyncExternalStore subscriptions caused
// a render storm. One popover keeps the cost flat regardless of mention
// count.

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import {
  ArrowRight01Icon,
  AtIcon,
  BubbleChatIcon,
  Copy01Icon,
  RefreshIcon,
  Robot02Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";

import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { Icon } from "@/components/Icon";
import { PresenceDot } from "@/components/PresenceDot";
import { UserAvatar } from "@/components/UserAvatar";
import { useAgentStatus } from "@/hooks/useAgentPresence";
import { useUserLastSeen, useUserLastSeenLabel, useUserStatus } from "@/hooks/useUserPresence";
import { agentStatusLabel } from "@/lib/agentLiveness";
import {
  createOrGetMmDirect,
  getAgentProfile,
  type GlobalUserStatus,
  type MmChannelMember,
} from "@/lib/api";
import { generateAgentDescription } from "@/lib/agentDescription";
import { queryKeys } from "@/lib/queryKeys";
import { useActiveOrg } from "@/hooks/useActiveOrg";
import { formatRelativeShort, resolveLastSeen } from "@/lib/formatting";
import { toast } from "@/lib/toast";

interface ProfileMenuTarget {
  member: MmChannelMember;
  /** Literal "@handle" used as the secondary line and copy/mention payload. */
  handleText: string;
  /** Anchor element the popover should align to. */
  anchor: HTMLElement;
}

interface ProfileMenuContextValue {
  open: (target: ProfileMenuTarget) => void;
}

const ProfileMenuContext = createContext<ProfileMenuContextValue | null>(null);

interface ProfileMenuProviderProps {
  orgId?: string | null;
  currentUserId?: number | null;
  /** Inserts ``@handle `` at the channel composer. Action hidden when absent. */
  onMentionInsert?: (handle: string) => void;
  children: ReactNode;
}

/** Page-level provider. Mounts one Popover; descendants open it via
 *  ``useProfileMenuTrigger``. Place this once per chat surface (channel
 *  page, DM page) so all avatars / names / mentions inside route to
 *  the same popover. */
export function ProfileMenuProvider({
  orgId,
  currentUserId,
  onMentionInsert,
  children,
}: ProfileMenuProviderProps) {
  const [target, setTarget] = useState<ProfileMenuTarget | null>(null);

  const open = useCallback((next: ProfileMenuTarget) => {
    setTarget(next);
  }, []);
  const close = useCallback(() => {
    setTarget(null);
  }, []);

  const ctxValue = useMemo<ProfileMenuContextValue>(
    () => ({ open }),
    [open],
  );

  return (
    <ProfileMenuContext.Provider value={ctxValue}>
      {children}
      {target && (
        <SharedProfileMenuPopover
          target={target}
          orgId={orgId}
          currentUserId={currentUserId}
          onMentionInsert={onMentionInsert}
          onClose={close}
        />
      )}
    </ProfileMenuContext.Provider>
  );
}

/** Hook the trigger components use. Returns a click handler that opens
 *  the shared popover anchored at the clicked element. Safe to call
 *  outside the provider — without a provider the handler is a no-op. */
export function useProfileMenuTrigger(
  member: MmChannelMember | null,
  handleText: string,
): (e: React.MouseEvent<HTMLElement>) => void {
  const ctx = useContext(ProfileMenuContext);
  return useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (!ctx || !member) return;
      e.preventDefault();
      e.stopPropagation();
      ctx.open({ member, handleText, anchor: e.currentTarget });
    },
    [ctx, member, handleText],
  );
}

/** Cheap button wrapper that opens the shared popover. Use anywhere we
 *  want avatar / name / mention to behave as a trigger — accepts the
 *  same children and styles as the inline element it replaces. */
export const ProfileMenuTrigger = memo(function ProfileMenuTrigger({
  member,
  handleText,
  children,
  className,
  ariaLabel,
}: {
  member: MmChannelMember | null;
  handleText: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  const onClick = useProfileMenuTrigger(member, handleText);
  if (!member) {
    return <>{children}</>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? `Open profile for ${handleText}`}
      className={className ?? "inline-flex cursor-pointer rounded-md outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring/40"}
    >
      {children}
    </button>
  );
});

function statusLabel(
  status: GlobalUserStatus | null,
  lastSeen: string | null,
  lastSeenLabel: string | null,
): string | null {
  if (status === "online") return "Online";
  if (status === "idle") return "Idle";
  if (lastSeen || lastSeenLabel) {
    return `Last active ${resolveLastSeen(lastSeen, lastSeenLabel)}`;
  }
  return null;
}

interface SharedProfileMenuPopoverProps {
  target: ProfileMenuTarget;
  orgId?: string | null;
  currentUserId?: number | null;
  onMentionInsert?: (handle: string) => void;
  onClose: () => void;
}

/** The actual popover content. One instance per page, lives only while
 *  a target is set. Uses base-ui's Popover with a controlled
 *  ``triggerProps`` anchor so it positions against whatever element
 *  the click came from. */
function SharedProfileMenuPopover({
  target,
  orgId,
  currentUserId,
  onMentionInsert,
  onClose,
}: SharedProfileMenuPopoverProps) {
  const { member, handleText, anchor } = target;
  const navigate = useNavigate();
  const isAgent = member.agent_id != null;
  const isSelf =
    !isAgent && currentUserId != null && member.human_id === currentUserId;
  const handleClean = handleText.startsWith("@")
    ? handleText.slice(1)
    : handleText;
  const displayName = member.display_name ?? member.agent_id ?? handleClean;

  const liveStatus = useUserStatus(member.human_id ?? undefined);
  const liveLastSeen = useUserLastSeen(member.human_id ?? undefined);
  const liveLastSeenLabel = useUserLastSeenLabel(member.human_id ?? undefined);
  const agentStatus = useAgentStatus(member.agent_id ?? undefined);
  const agentStatusText = isAgent ? agentStatusLabel(agentStatus) : null;
  const effectiveStatus: GlobalUserStatus | null = isAgent
    ? null
    : (liveStatus ?? member.status ?? "offline");
  const effectiveLastSeen = isAgent
    ? null
    : (liveLastSeen ?? member.last_seen_at);
  const effectiveLastSeenLabel = isAgent
    ? null
    : (liveLastSeenLabel ?? member.last_seen_label ?? null);
  const statusText = statusLabel(
    effectiveStatus,
    effectiveLastSeen,
    effectiveLastSeenLabel,
  );

  const avatarSeed = isAgent
    ? (member.display_name ?? member.agent_id ?? handleClean)
    : member.human_id != null
      ? String(member.human_id)
      : (member.display_name ?? handleClean);

  const openDmMutation = useMutation({
    mutationFn: () => {
      if (!orgId) throw new Error("No active organization");
      const kind: "agent" | "human" = isAgent ? "agent" : "human";
      const id = isAgent ? member.agent_id! : String(member.human_id);
      return createOrGetMmDirect(orgId, kind, id);
    },
    onSuccess: (channel) => {
      onClose();
      navigate(`/channels/${channel.channel_id}`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Could not open DM");
    },
  });

  // Agent description for the menu. Reuses the agent-profile query key so it
  // shares the cache with the full profile page (and pre-warms the "View full
  // profile" navigation). Only fetched when the target is an agent.
  const agentProfileQuery = useQuery({
    queryKey: queryKeys.agentProfile(orgId ?? "", member.agent_id ?? ""),
    queryFn: () => getAgentProfile(orgId ?? "", member.agent_id ?? ""),
    enabled: isAgent && Boolean(orgId) && Boolean(member.agent_id),
    staleTime: 60_000,
  });
  const agentDescription = isAgent
    ? agentProfileQuery.data?.description?.trim() || null
    : null;

  // "Refresh description" is allowed for the agent's operator OR an owner of
  // the active org (mirrors the backend's regenerate authorization).
  const queryClient = useQueryClient();
  const { isOwner: isOrgOwner } = useActiveOrg();
  const canManageDescription =
    isAgent && Boolean(orgId) && (Boolean(agentProfileQuery.data?.is_operator) || isOrgOwner);
  const descriptionRegenPending = Boolean(agentProfileQuery.data?.description_regen_pending);
  const regenDescMutation = useMutation({
    mutationFn: () => generateAgentDescription(orgId ?? "", member.agent_id ?? ""),
    onSuccess: () => {
      toast.success("Asked the agent to refresh its description");
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentProfile(orgId ?? "", member.agent_id ?? "") });
      onClose();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Couldn't request a refresh");
    },
  });

  const copyMention = async () => {
    try {
      await navigator.clipboard.writeText(`@${handleClean}`);
      toast.success("Mention copied");
    } catch {
      toast.error("Copy failed");
    }
    onClose();
  };

  const mentionHere = () => {
    onMentionInsert?.(handleClean);
    onClose();
  };

  const goToAgentProfile = () => {
    onClose();
    if (isAgent && member.agent_id) {
      navigate(`/agents/${encodeURIComponent(member.agent_id)}`);
    }
  };

  const goToEditProfile = () => {
    onClose();
    navigate("/settings/profile");
  };

  const hasDetailRow =
    Boolean(statusText) || Boolean(agentStatusText) || Boolean(member.joined_at);

  // Close on scroll. The anchor lives inside the virtua-virtualized chat
  // list, so scrolling can recycle the anchored row out of the DOM; a
  // detached anchor reports a zeroed rect and the positioner collapses to
  // the top-left corner. Rather than chase a vanished anchor, dismiss.
  // Scroll events don't bubble, so we listen in the capture phase on the
  // document to catch any nested scroller. Arming on the next frame keeps
  // the open-time focus/layout pass from instantly self-closing it.
  useEffect(() => {
    let armed = false;
    const raf = requestAnimationFrame(() => {
      armed = true;
    });
    const onScroll = () => {
      if (armed) onClose();
    };
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [onClose]);

  // base-ui's Popover accepts an ``anchor`` on the Positioner. We give
  // it the clicked element and keep ``open`` controlled at true while
  // this component is mounted — the parent unmounts on close.
  return (
    <PopoverPrimitive.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={anchor}
          side="top"
          sideOffset={8}
          align="start"
          className="isolate z-50"
        >
          <PopoverPrimitive.Popup
            // Liquid-glass card:
            //   - a tinted, mostly-opaque fill + saturate so colour behind
            //     the popup still bleeds through glass-style, while staying
            //     legible over light backgrounds (the old ~35% alpha washed
            //     out against white);
            //   - a soft outer shadow and an inset hairline ring carry
            //     the depth without a hard border;
            //   - the ``before:`` pseudo paints a 1px gradient highlight
            //     across the top edge (the "wet" gloss line you see on
            //     Apple's liquid-glass surfaces).
            className={[
              "relative z-50 w-72 origin-(--transform-origin) overflow-hidden",
              "rounded-2xl outline-none",
              "bg-popover/85 text-popover-foreground",
              "shadow-[0_18px_45px_-12px_rgba(0,0,0,0.45),0_2px_6px_-2px_rgba(0,0,0,0.25)]",
              "ring-1 ring-inset ring-foreground/[0.06]",
              "backdrop-blur-2xl backdrop-saturate-150",
              "supports-[backdrop-filter]:bg-popover/70",
              "before:pointer-events-none before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-foreground/15 before:to-transparent",
              "transition-[opacity,transform] duration-150",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
            ].join(" ")}
          >
            {isAgent && (
              <Icon
                icon={Robot02Icon}
                aria-label="Agent"
                className="pointer-events-none absolute right-3 top-3 size-3.5 text-muted-foreground/80"
              />
            )}

            {/* Header — slightly larger avatar (52px) for presence,
                tighter typography, presence dot ringed in the popup
                background colour so the seam disappears on glass. */}
            <div className="flex items-start gap-3 px-4 pt-4 pb-3">
              <span className="relative flex shrink-0">
                {isAgent ? (
                  <AgentFaceAvatar
                    size={52}
                    name={avatarSeed}
                    src={member.avatar?.url}
                    framed={false}
                  />
                ) : (
                  <UserAvatar size={52} name={avatarSeed} src={member.avatar?.url}/>
                )}
                {!isAgent && effectiveStatus && (
                  <span className="pointer-events-none absolute bottom-0 right-0">
                    <PresenceDot
                      status={effectiveStatus}
                      size={12}
                      ringClassName="ring-popover/40"
                    />
                  </span>
                )}
                {isAgent && (
                  <span className="pointer-events-none absolute bottom-0 right-0">
                    <PresenceDot
                      status={agentStatus}
                      size={12}
                      ringClassName="ring-popover/40"
                      label={agentStatusLabel(agentStatus)}
                    />
                  </span>
                )}
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="truncate pr-5 text-[15px] font-semibold leading-tight tracking-tight text-foreground">
                  {displayName}
                </div>
                <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                  @{handleClean}
                </div>
                {isSelf && (
                  <div className="mt-1 inline-flex items-center rounded-full bg-foreground/8 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                    You
                  </div>
                )}
              </div>
            </div>

            {agentDescription && (
              // Agent's auto-generated "what people use me for" summary. Full
              // text (not truncated like the card) — capped to a few lines so a
              // long description can't blow out the popover height.
              <div className="border-t border-foreground/[0.06] px-4 py-2.5 text-[12px] leading-snug text-muted-foreground">
                <p className="line-clamp-4">{agentDescription}</p>
              </div>
            )}

            {hasDetailRow && (
              // Two-column meta row: live status on the left (truncated
              // if it grows long), join date pinned to the right edge.
              // ``mr-auto`` on the status keeps "Joined …" right-aligned
              // even when the status is missing (agents).
              <div className="flex items-center gap-3 border-t border-foreground/[0.06] px-4 py-2.5 text-[12px] text-muted-foreground">
                {!isAgent && statusText && (
                  <span className="min-w-0 mr-auto truncate">{statusText}</span>
                )}
                {isAgent && agentStatusText && (
                  <span className="min-w-0 mr-auto truncate">{agentStatusText}</span>
                )}
                {member.joined_at && (
                  <span className="shrink-0 ml-auto">
                    Joined {formatRelativeShort(member.joined_at)}
                  </span>
                )}
              </div>
            )}

            <div className="flex flex-col gap-0.5 border-t border-foreground/[0.06] p-1.5">
              {isSelf ? (
                <>
                  <ActionButton
                    icon={Settings02Icon}
                    label="Edit profile"
                    onClick={goToEditProfile}
                  />
                  <ActionButton
                    icon={Copy01Icon}
                    label="Copy @mention"
                    onClick={copyMention}
                  />
                </>
              ) : (
                <>
                  {orgId && (
                    <ActionButton
                      icon={BubbleChatIcon}
                      label={openDmMutation.isPending ? "Opening…" : "Send message"}
                      onClick={() => openDmMutation.mutate()}
                      disabled={openDmMutation.isPending}
                    />
                  )}
                  {onMentionInsert && (
                    <ActionButton
                      icon={AtIcon}
                      label="Mention in this channel"
                      onClick={mentionHere}
                    />
                  )}
                  <ActionButton
                    icon={Copy01Icon}
                    label="Copy @mention"
                    onClick={copyMention}
                  />
                  {isAgent && (
                    <ActionButton
                      icon={ArrowRight01Icon}
                      label="View full profile"
                      onClick={goToAgentProfile}
                    />
                  )}
                  {canManageDescription && (
                    <ActionButton
                      icon={RefreshIcon}
                      label={
                        regenDescMutation.isPending || descriptionRegenPending
                          ? "Refreshing description…"
                          : "Refresh description"
                      }
                      onClick={() => regenDescMutation.mutate()}
                      disabled={regenDescMutation.isPending || descriptionRegenPending}
                    />
                  )}
                </>
              )}
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof Copy01Icon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group/action flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] text-foreground/90 transition-colors hover:bg-foreground/[0.07] active:bg-foreground/[0.10] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon
        icon={icon}
        className="size-4 shrink-0 text-muted-foreground/80 transition-colors group-hover/action:text-foreground"
      />
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}
