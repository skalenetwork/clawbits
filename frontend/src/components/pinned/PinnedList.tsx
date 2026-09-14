import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { PinOffIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { PostAvatar } from "@/components/chat/PostAvatar";
import { PanelNote } from "@/components/sidebars/RightPanel";
import { useAuth } from "@/context/AuthContext";
import { usePinToggle, usePinnedPosts } from "@/hooks/usePinnedPosts";
import { listMmChannelMembers } from "@/lib/api";
import { formatRelativeShort } from "@/lib/formatting";
import { posterName } from "@/lib/messageHelpers";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** A channel's pinned messages as sidebar rows. A row jumps to its message
 *  through the ``?msg=`` deep link ChannelPage already handles. */
export function PinnedList({
  channelId,
  touch = false,
  onJump,
}: {
  channelId: string;
  touch?: boolean;
  onJump?: () => void;
}) {
  const pinned = usePinnedPosts(channelId);
  const members = useQuery({
    queryKey: queryKeys.mm.channelMembers(channelId),
    queryFn: () => listMmChannelMembers(channelId),
  });
  const toggle = usePinToggle(channelId);
  const { user } = useAuth();
  const [, setSearchParams] = useSearchParams();
  const pins = pinned.data?.posts ?? [];

  if (pinned.isLoading) return <PanelNote>Loading…</PanelNote>;
  if (pinned.isError) return <PanelNote error>{errMsg(pinned.error, "Couldn't load pinned messages")}</PanelNote>;
  if (pins.length === 0) return <PanelNote>Nothing pinned yet.</PanelNote>;
  return (
    <ul className="flex flex-col gap-px">
      {pins.map((post) => {
        const author = posterName(post);
        const pinnerId = post.pinned_by_human_id;
        const pinnedBy = pinnerId == null
          ? null
          : pinnerId === user?.id
            ? "You"
            : members.data?.members.find((m) => m.human_id === pinnerId)?.display_name;
        return (
          <li key={post.post_id} className="group/pin relative rounded-lg px-2.5 py-2 transition-colors hover:bg-[var(--sb-hover)]">
            <button
              type="button"
              onClick={() => {
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set("msg", String(post.post_id));
                  return next;
                }, { replace: true });
                onJump?.();
              }}
              aria-label={`Jump to pinned message from ${author}`}
              className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <div className="pointer-events-none flex items-center gap-2 pr-6 text-[13px]">
              <PostAvatar post={post} size={20} />
              <span className="min-w-0 truncate font-medium text-muted-foreground">{author}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {formatRelativeShort(post.created_at)}
              </span>
            </div>
            <p className="pointer-events-none mt-1 line-clamp-3 text-[13px] leading-snug wrap-anywhere">
              {post.message}
            </p>
            {pinnedBy && (
              <p className="pointer-events-none mt-1 text-[11px] text-muted-foreground">Pinned by {pinnedBy}</p>
            )}
            <button
              type="button"
              onClick={() => { toggle.mutate(post); }}
              disabled={toggle.isPending}
              aria-label="Unpin message"
              title="Unpin"
              className={cn(
                "absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-md text-muted-foreground transition-opacity hover:text-sidebar-foreground disabled:opacity-30",
                !touch && "opacity-0 group-hover/pin:opacity-100 focus-visible:opacity-100",
              )}
            >
              <Icon icon={PinOffIcon} className="size-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
