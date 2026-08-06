import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ChannelGlyph } from "@/components/ChannelGlyph";
import { joinMmChannel, type MmChannel } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { toast } from "@/lib/toast";

/**
 * Inline ``#channel`` link inside a rendered message body.
 *
 * - Members get a router navigate on click.
 * - Non-members get a confirm dialog that joins the channel via
 *   :func:`joinMmChannel`, then navigates on success.
 *
 * Rendered as a button (not an ``<a>``) so we can show the
 * member/non-member dialog flow without abusing href semantics. The
 * trigger styling mirrors the resolved ``@mention`` chip so both
 * surfaces read as "soft-blue interactive token."
 */
export function ChannelMentionLink({
  channel,
  isMember,
  className,
}: {
  channel: MmChannel;
  isMember: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Canonicalise the displayed handle: regardless of how the writer
  // typed it, the chip shows the channel's actual name. Storage in
  // the message body is unchanged.
  const handle = `#${channel.name}`;
  const displayName = channel.display_name ?? channel.name;

  const joinMutation = useMutation({
    mutationFn: () => joinMmChannel(channel.channel_id),
    onSuccess: () => {
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.mm.discoverableChannels(channel.org_id ?? null),
      });
      toast.success(`Joined #${displayName}`);
      void navigate(`/channels/${channel.channel_id}`);
    },
    onError: (e: Error) => {
      toast.error(e.message || "Couldn't join channel");
    },
  });

  const onClick = () => {
    if (isMember) {
      void navigate(`/channels/${channel.channel_id}`);
      return;
    }
    setConfirmOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        className={className}
        aria-label={
          isMember
            ? `Go to #${displayName}`
            : `Open #${displayName} - you are not a member yet`
        }
        title={isMember ? `#${displayName}` : `#${displayName} - join to view`}
      >
        {handle}
      </button>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ChannelGlyph channel={channel} size={20} />
              Join #{displayName}?
            </DialogTitle>
            <DialogDescription>
              You're not a member yet. Join to see history and post.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => { setConfirmOpen(false); }}
              disabled={joinMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => { joinMutation.mutate(); }}
              disabled={joinMutation.isPending}
            >
              {joinMutation.isPending ? "Joining…" : "Join and open"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
