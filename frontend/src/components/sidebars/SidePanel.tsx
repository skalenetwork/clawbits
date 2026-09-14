import { useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { RightPanel } from "@/components/sidebars/RightPanel";
import { RightPanelSlotContext } from "@/components/sidebars/rightPanelContext";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-mobile";

export function SidePanel({
  open,
  title,
  actions,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const slot = useContext(RightPanelSlotContext);

  if (isMobile) {
    return (
      <Drawer
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <DrawerContent>
          <DrawerHeader className="flex-row items-center justify-between gap-2">
            <DrawerTitle>{title}</DrawerTitle>
            {actions && <div className="flex items-center gap-1">{actions}</div>}
          </DrawerHeader>
          {children}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    slot &&
    createPortal(
      <RightPanel open={open} title={title} actions={actions} wide onClose={onClose}>
        {children}
      </RightPanel>,
      slot,
    )
  );
}
