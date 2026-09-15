import { createContext } from "react";

export const RightPanelSlotContext = createContext<HTMLElement | null>(null);

export const PANEL_ICON_BUTTON =
  "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--sb-hover)] hover:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-50";
