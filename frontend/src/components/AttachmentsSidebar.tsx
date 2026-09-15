import { RightPanel } from "@/components/sidebars/RightPanel";
import { AttachmentTabs } from "@/components/attachments/AttachmentTabs";
import { MediaTab } from "@/components/attachments/MediaTab";
import { FilesTab } from "@/components/attachments/FilesTab";
import { LinksTab } from "@/components/attachments/LinksTab";
import { useAttachmentTab } from "@/lib/attachmentTabs";

/**
 * Right-edge Attachments panel: the per-channel media / files / links browser.
 * Only the active tab is mounted, and its query is gated on ``open`` so a
 * collapsed panel never fetches.
 */
export default function AttachmentsSidebar({
  channelId,
  open,
  onClose,
}: {
  channelId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useAttachmentTab();

  return (
    <RightPanel
      open={open}
      title="Attachments"
      onClose={onClose}
      below={<AttachmentTabs value={tab} onValueChange={setTab} />}
    >
      {tab === "media" && <MediaTab channelId={channelId} active={open} />}
      {tab === "files" && <FilesTab channelId={channelId} active={open} />}
      {tab === "links" && <LinksTab channelId={channelId} active={open} />}
    </RightPanel>
  );
}
