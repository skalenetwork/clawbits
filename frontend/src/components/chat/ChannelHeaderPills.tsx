import { useState } from "react";
import { PinIcon, PinOffIcon } from "@hugeicons/core-free-icons";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { Icon } from "@/components/Icon";
import { PresenceDot } from "@/components/PresenceDot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import { useUserStatus } from "@/hooks/useUserPresence";
import type { MmChannelMember, MmChannelPost } from "@/lib/api";
import { formatTimeOnly } from "@/lib/formatting";
import { posterName } from "@/lib/messageHelpers";

/** Trailing presence dot for the DM channel-page header pill — sits at
 *  the right end of the pill, no text label, matching channel-pill height. */
export function DmPillStatus({ humanId }: { humanId: number }) {
  const status = useUserStatus(humanId);
  return (
    <PresenceDot status={status} size={8} ringClassName="ring-background/40" />
  );
}

/** Header button that surfaces the pinned-message count. Matches the
 *  members/details button styling (a ghost button on the unified header bar).
 *  Clicking opens the full pinned list: a bottom-sheet DRAWER on mobile (the
 *  touch counterpart, matching the members drawer) and a popover on desktop. */
export function PinnedPill({
  pins,
  loading,
  error,
  currentUserId,
  members,
  onJump,
  onUnpin,
  pinning,
}: {
  pins: MmChannelPost[];
  loading: boolean;
  error: boolean;
  currentUserId: number | null;
  members: MmChannelMember[];
  onJump: (postId: number) => void;
  onUnpin: (post: MmChannelPost) => void;
  pinning: boolean;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const count = pins.length;
  const label = `${String(count)} pinned ${count === 1 ? "message" : "messages"}`;
  const triggerClass =
    "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-foreground/5 hover:text-foreground data-[popup-open]:bg-sidebar-foreground/10 data-[popup-open]:text-foreground";

  // Shared list body — identical rows in the drawer (mobile) and popover
  // (desktop). ``touch`` keeps the unpin button visible without hover.
  const rows = (
    <>
      {loading && pins.length === 0 && (
        <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>
      )}
      {error && (
        <p className="py-6 text-center text-xs text-destructive">
          Couldn't load pinned messages.
        </p>
      )}
      {!loading && !error && pins.length === 0 && (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Nothing pinned yet.
        </p>
      )}
      {pins.map((post) => (
        <PinnedRow
          key={post.post_id}
          post={post}
          currentUserId={currentUserId}
          members={members}
          touch={isMobile}
          onJump={() => {
            setOpen(false);
            onJump(post.post_id);
          }}
          onUnpin={() => { onUnpin(post); }}
          pinning={pinning}
        />
      ))}
    </>
  );

  if (isMobile) {
    return (
      <>
        <button
          type="button"
          aria-label={label}
          onClick={() => { setOpen(true); }}
          className={triggerClass}
        >
          <Icon icon={PinIcon} className="size-3.5 shrink-0"/>
          <span className="tabular-nums">{count}</span>
        </button>
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Pinned {count === 1 ? "message" : "messages"}</DrawerTitle>
              <p className="text-sm text-muted-foreground">
                {count === 1 ? "1 message" : `${String(count)} messages`}
              </p>
            </DrawerHeader>
            <div className="flex flex-col pb-2">{rows}</div>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        render={
          <button type="button" aria-label={label} className={triggerClass}>
            <Icon icon={PinIcon} className="size-3.5 shrink-0"/>
            <span className="tabular-nums">{count}</span>
          </button>
        }
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align="end"
          side="bottom"
          sideOffset={8}
          className="isolate z-50"
        >
          <PopoverPrimitive.Popup
            className="z-50 w-[min(420px,calc(100vw-2rem))] origin-(--transform-origin) overflow-hidden rounded-xl border border-border/60 bg-background/95 shadow-lg backdrop-blur-xl ring-1 ring-foreground/5 data-[side=bottom]:slide-in-from-top-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <div className="flex items-center justify-between border-b border-border/40 px-4 py-2.5">
              <span className="text-xs font-semibold text-foreground">
                Pinned {count === 1 ? "message" : "messages"}
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground/70">{count}</span>
            </div>
            <div className="max-h-[min(60vh,28rem)] overflow-y-auto p-1.5">{rows}</div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** One row in the pinned-messages popover. Click jumps to the message
 *  in the timeline; the trailing unpin button removes the pin without
 *  closing the popover so the user can clean up several pins quickly. */
function PinnedRow({
  post,
  currentUserId,
  members,
  onJump,
  onUnpin,
  pinning,
  touch = false,
}: {
  post: MmChannelPost;
  currentUserId: number | null;
  members: MmChannelMember[];
  onJump: () => void;
  onUnpin: () => void;
  pinning: boolean;
  /** Touch surfaces (the mobile drawer) have no hover, so the unpin button
   *  must stay visible rather than reveal on ``group-hover``. */
  touch?: boolean;
}) {
  const authorName = posterName(post);
  // Resolve the pinner's display name from the member list if we can; a
  // hard-coded "You" beats showing a stale user id for the common case
  // where the caller pinned the message themselves.
  const pinnedByName = post.pinned_by_human_id != null
    ? (post.pinned_by_human_id === currentUserId
        ? "You"
        : (members.find((m) => m.human_id === post.pinned_by_human_id)?.display_name
           ?? `User ${String(post.pinned_by_human_id)}`))
    : null;
  return (
    <div className="group/pin flex items-start gap-2 rounded-md px-2 py-2 transition-colors hover:bg-muted/40">
      <button
        type="button"
        onClick={onJump}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
        aria-label={`Jump to pinned message from ${authorName}`}
      >
        <div className="flex w-full items-baseline gap-2">
          <span className="truncate text-xs font-semibold tracking-tight">{authorName}</span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {formatTimeOnly(post.created_at)}
          </span>
        </div>
        <p className="line-clamp-2 w-full text-[13px] leading-snug text-foreground/85">
          {post.message}
        </p>
        {pinnedByName && post.pinned_at && (
          <span className="text-[10px] text-muted-foreground/70">
            Pinned by {pinnedByName}
          </span>
        )}
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onUnpin(); }}
              disabled={pinning}
              aria-label="Unpin message"
              className={`flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground disabled:opacity-30 ${touch ? "opacity-70" : "opacity-0 group-hover/pin:opacity-100"}`}
            >
              <Icon icon={PinOffIcon} className="size-3.5"/>
            </button>
          }
        />
        <TooltipContent side="top" sideOffset={4} className="text-xs">Unpin</TooltipContent>
      </Tooltip>
    </div>
  );
}
