import { PinnedList } from "@/components/pinned/PinnedList";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";

/** Mobile Pinned bottom sheet, the touch counterpart to ``PinnedSidebar``. */
export function MobilePinnedDrawer({
  channelId,
  open,
  onOpenChange,
}: {
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Pinned messages</DrawerTitle>
        </DrawerHeader>
        <PinnedList channelId={channelId} touch onJump={() => { onOpenChange(false); }} />
      </DrawerContent>
    </Drawer>
  );
}
