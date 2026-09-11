import { RightPanel } from "@/components/sidebars/RightPanel";
import { PinnedList } from "@/components/pinned/PinnedList";

/** Right-edge Pinned panel: the channel's pinned messages, each jumping to its place in the chat. */
export default function PinnedSidebar({
  channelId,
  open,
  onClose,
}: {
  channelId: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <RightPanel open={open} title="Pinned messages" onClose={onClose}>
      <PinnedList channelId={channelId} />
    </RightPanel>
  );
}
