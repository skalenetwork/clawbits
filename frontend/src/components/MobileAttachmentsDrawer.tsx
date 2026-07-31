import { AttachmentTabs } from "@/components/attachments/AttachmentTabs";
import { MediaTab } from "@/components/attachments/MediaTab";
import { FilesTab } from "@/components/attachments/FilesTab";
import { LinksTab } from "@/components/attachments/LinksTab";
import { useAttachmentTab } from "@/lib/attachmentTabs";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

interface MobileAttachmentsDrawerProps {
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Mobile Attachments bottom sheet — the touch counterpart to the desktop
 * ``AttachmentsSidebar``. Same Media / Files / Links tabs and content, in a
 * drag-to-dismiss drawer. The tab strip sticks to the top of the sheet's
 * scroll area; the drawer owns the scroll + height cap. Queries are gated on
 * ``open`` so nothing fetches until the sheet is shown.
 */
export function MobileAttachmentsDrawer({
  channelId,
  open,
  onOpenChange,
}: MobileAttachmentsDrawerProps) {
  const [tab, setTab] = useAttachmentTab();

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Attachments</DrawerTitle>
        </DrawerHeader>
        <div className="sticky top-0 z-10 -mx-4 mb-2 bg-popover/80 px-4 pb-2 backdrop-blur-sm supports-backdrop-filter:bg-popover/60">
          <AttachmentTabs value={tab} onValueChange={setTab} />
        </div>
        {tab === "media" && <MediaTab channelId={channelId} active={open} />}
        {tab === "files" && <FilesTab channelId={channelId} active={open} />}
        {tab === "links" && <LinksTab channelId={channelId} active={open} />}
      </DrawerContent>
    </Drawer>
  );
}
