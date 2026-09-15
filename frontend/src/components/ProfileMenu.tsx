import { memo, useEffect, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { AtIcon, BubbleChatIcon, Settings02Icon, UserIcon } from "@hugeicons/core-free-icons";

import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { Icon, type AppIcon } from "@/components/Icon";
import { PresenceDot } from "@/components/PresenceDot";
import { UserAvatar } from "@/components/UserAvatar";
import {
  ProfileMenuContext,
  useProfileMenuTrigger,
  type ProfileMember,
  type ProfileMenuTarget,
} from "@/components/profileMenuContext";
import { useAgentStatus } from "@/hooks/useAgentPresence";
import { useUserStatus } from "@/hooks/useUserPresence";
import { agentStatusLabel } from "@/lib/agentLiveness";
import { createOrGetMmDirect } from "@/lib/api";
import { MENU_ITEM, MENU_SURFACE } from "@/lib/menuSurface";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface ProfileCardOptions {
  orgId?: string | null;
  currentUserId?: number | null;
  /** Inserts `@handle ` at the composer; the Mention action hides without it. */
  onMentionInsert?: (handle: string) => void;
}

/** One shared popover per chat surface: a Popover per avatar and mention caused a render storm at 100+ triggers. */
export function ProfileMenuProvider({ children, ...options }: ProfileCardOptions & { children: ReactNode }) {
  const [target, setTarget] = useState<ProfileMenuTarget | null>(null);
  const open = (next: ProfileMenuTarget) => {
    setTarget(prev => (prev?.anchor === next.anchor ? null : next));
  };
  const close = () => {
    setTarget(null);
  };

  return (
    <ProfileMenuContext value={{ open }}>
      {children}
      {target && <ProfileCard {...options} target={target} onClose={close} />}
    </ProfileMenuContext>
  );
}

export const ProfileMenuTrigger = memo(function ProfileMenuTrigger({
  member,
  handleText,
  children,
  className,
  ariaLabel,
}: {
  member: ProfileMember | null;
  handleText: string;
  children: ReactNode;
  className: string;
  ariaLabel: string;
}) {
  const onClick = useProfileMenuTrigger(member, handleText);
  if (!member) return children;
  return (
    <button type="button" onClick={onClick} aria-label={ariaLabel} className={className}>
      {children}
    </button>
  );
});

function ProfileCard({
  target: { member, handleText, anchor },
  orgId,
  currentUserId,
  onMentionInsert,
  onClose,
}: ProfileCardOptions & { target: ProfileMenuTarget; onClose: () => void }) {
  const navigate = useNavigate();
  const agentId = member.agent_id;
  const handle = handleText.replace(/^@/, "");
  const displayName = member.display_name ?? agentId ?? handle;
  const isSelf = agentId == null && currentUserId != null && member.human_id === currentUserId;
  const humanStatus = useUserStatus(member.human_id ?? undefined) ?? member.status ?? "offline";
  const agentStatus = useAgentStatus(agentId ?? undefined);

  const openDmMutation = useMutation({
    mutationFn: (org: string) =>
      createOrGetMmDirect(org, agentId == null ? "human" : "agent", agentId ?? String(member.human_id)),
    onSuccess: channel => {
      onClose();
      void navigate(`/channels/${channel.channel_id}`);
    },
    onError: err => {
      toast.error(err instanceof Error ? err.message : "Could not open DM");
    },
  });

  // Close on any scroll: virtua can recycle the anchor out of the DOM and collapse the popover to the corner.
  // Armed a frame late so the open-time layout pass does not close it.
  useEffect(() => {
    let armed = false;
    const raf = requestAnimationFrame(() => {
      armed = true;
    });
    const onScroll = () => {
      if (armed) onClose();
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [onClose]);

  return (
    <PopoverPrimitive.Root
      open
      onOpenChange={(o, { reason, event }) => {
        if (o || (reason === "outside-press" && event.target instanceof Node && anchor.contains(event.target))) return;
        onClose();
      }}
    >
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner anchor={anchor} side="top" sideOffset={8} align="start" className="isolate z-50">
          <PopoverPrimitive.Popup
            className={cn(
              MENU_SURFACE,
              "w-64 origin-(--transform-origin) outline-none transition-[opacity,transform] duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
            )}
          >
            <div className="flex items-center gap-3 px-2.5 py-2">
              <span className="relative flex shrink-0">
                {agentId == null ? (
                  <UserAvatar
                    size={40}
                    name={member.human_id == null ? displayName : String(member.human_id)}
                    src={member.avatar?.url}
                  />
                ) : (
                  <AgentFaceAvatar size={40} name={displayName} src={member.avatar?.url} framed={false} />
                )}
                <span className="pointer-events-none absolute right-0 bottom-0">
                  {agentId == null ? (
                    <PresenceDot status={humanStatus} size={10} ringClassName="ring-popover" />
                  ) : (
                    <PresenceDot
                      status={agentStatus}
                      size={10}
                      ringClassName="ring-popover"
                      label={agentStatusLabel(agentStatus)}
                    />
                  )}
                </span>
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{displayName}</div>
                <div className="truncate text-[13px] leading-5 text-muted-foreground">@{handle}</div>
              </div>
            </div>

            {isSelf ? (
              <ActionButton
                icon={Settings02Icon}
                label="Edit profile"
                onClick={() => {
                  onClose();
                  void navigate("/settings/profile");
                }}
              />
            ) : (
              <>
                {orgId && (
                  <ActionButton
                    icon={BubbleChatIcon}
                    label={openDmMutation.isPending ? "Opening…" : "Message"}
                    onClick={() => { openDmMutation.mutate(orgId); }}
                    disabled={openDmMutation.isPending}
                  />
                )}
                {onMentionInsert && (
                  <ActionButton
                    icon={AtIcon}
                    label="Mention"
                    onClick={() => {
                      onMentionInsert(handle);
                      onClose();
                    }}
                  />
                )}
                {agentId != null && (
                  <ActionButton
                    icon={UserIcon}
                    label="View profile"
                    onClick={() => {
                      onClose();
                      void navigate(`/agents/${encodeURIComponent(agentId)}`);
                    }}
                  />
                )}
              </>
            )}
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
  icon: AppIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(MENU_ITEM, "w-full text-left hover:bg-accent focus-visible:bg-accent disabled:opacity-50")}
    >
      <Icon icon={icon}/>
      <span className="truncate">{label}</span>
    </button>
  );
}
