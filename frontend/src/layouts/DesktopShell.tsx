import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Scrim } from "@/components/ProgressiveBlur";
import { RailNavShortcuts } from "@/components/RailNavShortcuts";
import { isDesktop } from "@/lib/desktop";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Settings01Icon } from "@hugeicons/core-free-icons";
import ChatInfoSidebar from "@/components/ChatInfoSidebar";
import PinnedSidebar from "@/components/PinnedSidebar";
import { useShortcut } from "@/lib/shortcuts";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { PageHeaderSlotProvider } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import { MainSidebar } from "@/components/sidebars/MainSidebar";
import { SettingsSidebar } from "@/components/sidebars/SettingsSidebar";
import { UpdateBanner } from "@/components/UpdateBanner";
import { SETTINGS_PATH } from "@/lib/navSections";
import { RightPanelSlotContext } from "@/components/sidebars/rightPanelContext";
import { SidebarToggle } from "@/components/sidebars/SidebarToggle";
import { cn } from "@/lib/utils";
import type { ChannelOutletContext, ChannelPanel } from "./AppShell";

const AttachmentsSidebar = lazy(() => import("@/components/AttachmentsSidebar"));

const SIDEBAR_OPEN_KEY = "fc_sidebar_open";

function SidebarShortcut() {
  const { toggleSidebar } = useSidebar();
  useShortcut({
    id: "sidebar-trigger",
    keys: "$mod+b",
    run: toggleSidebar,
    hint: { label: "B", group: "Layout", description: "Toggle sidebar" },
  });
  return null;
}

/** The sidebar and the page as two flat panes, plus the right-edge panels on channel routes. In the desktop app
 *  both reach the window's top edge and share the title bar row; only the sidebars show the window's vibrancy. */
export function DesktopShell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false");
  const [rightPanel, setRightPanel] = useState<ChannelPanel | null>(null);
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const [panelSlot, setPanelSlot] = useState<HTMLElement | null>(null);
  const closePanel = () => { setRightPanel(null); };

  const inSettings = pathname.startsWith("/settings");
  const isHome = pathname === "/home";
  const activeChannelId = /^\/channels\/([^/]+)/.exec(pathname)?.[1] ?? null;
  const fullBleed = activeChannelId !== null;

  const backTo = useRef("/home");
  useEffect(() => {
    if (!inSettings) backTo.current = pathname;
  }, [inSettings, pathname]);
  const leaveSettings = () => { void navigate(backTo.current); };
  useShortcut({
    id: "settings-back",
    keys: "Escape",
    when: ({ inEditable }) => inSettings && !inEditable && document.querySelector('[role="dialog"]') === null,
    run: leaveSettings,
  });

  const channelContext: ChannelOutletContext = {
    panel: rightPanel,
    togglePanel: (panel) => { setRightPanel((cur) => (cur === panel ? null : panel)); },
  };

  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={(open) => {
        setSidebarOpen(open);
        localStorage.setItem(SIDEBAR_OPEN_KEY, String(open));
      }}
    >
      <SidebarShortcut />
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <RightPanelSlotContext value={panelSlot}>
        <div className="relative flex min-w-0 flex-1 overflow-hidden">
          {sidebarOpen && (
            <aside data-vt-contextual="" className="relative z-[45] hidden w-(--sidebar-width) shrink-0 flex-col bg-sidebar md:flex">
              {isDesktop && (
                <div
                  data-tauri-drag-region
                  className="flex h-(--titlebar-height) shrink-0 items-center justify-end pr-2 [-webkit-app-region:drag]"
                >
                  <SidebarToggle />
                </div>
              )}
              {inSettings ? <SettingsSidebar /> : <MainSidebar />}
              <div className="flex flex-col gap-2 px-2 pb-2">
                <UpdateBanner />
                {inSettings ? (
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton onClick={leaveSettings} className="text-muted-foreground">
                        <ArrowLeft />
                        <span>Back</span>
                        <span
                          aria-hidden="true"
                          className="ml-auto grid h-5 min-w-5 place-items-center rounded-md bg-foreground/10 px-1 text-[11px]"
                        >
                          Esc
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                ) : (
                  <div className="flex items-center gap-1">
                    <OrgSwitcher />
                    <NavLink
                      to={SETTINGS_PATH}
                      title="Settings"
                      aria-label="Settings"
                      className="grid size-[34px] shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-[var(--sb-hover)] hover:text-sidebar-foreground"
                    >
                      <Icon icon={Settings01Icon} className="size-4" />
                    </NavLink>
                  </div>
                )}
              </div>
            </aside>
          )}

          {!sidebarOpen && (
            <div className="absolute bottom-2 left-2 z-30 w-(--sidebar-width) rounded-xl bg-card shadow-md empty:hidden">
              <UpdateBanner />
            </div>
          )}

          <PageHeaderSlotProvider value={headerSlot}>
            <div className="relative flex min-w-0 flex-1 flex-col bg-background">
              {(!isHome || !sidebarOpen) && (
                <div
                  data-tauri-drag-region
                  className={cn(
                    "absolute inset-x-0 top-0 z-[45] flex h-(--header-height) items-center gap-2 px-3",
                    isDesktop && !sidebarOpen && "pl-(--titlebar-inset)",
                  )}
                >
                  <Scrim color="background" />
                  {!sidebarOpen && <SidebarToggle />}
                  <div ref={setHeaderSlot} data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center justify-between gap-2" />
                </div>
              )}
              <div className="flex min-h-0 flex-1">
                <main
                  id="main-content"
                  tabIndex={-1}
                  className={cn("min-w-0 flex-1 overflow-y-auto outline-none", !fullBleed && "gutter-stable-both")}
                >
                  {fullBleed ? (
                    <div className="flex h-full w-full flex-col">
                      <Outlet context={activeChannelId ? channelContext : undefined} />
                    </div>
                  ) : (
                    <div className={cn("mx-auto flex min-h-full w-full max-w-content flex-col px-2", isHome ? "pt-(--titlebar-height)" : "pt-16")}>
                      <Outlet />
                    </div>
                  )}
                </main>
              </div>
            </div>
          </PageHeaderSlotProvider>
        </div>
      </RightPanelSlotContext>

      {isDesktop && <RailNavShortcuts />}
      {activeChannelId && (
        <>
          <ChatInfoSidebar channelId={activeChannelId} open={rightPanel === "info"} onClose={closePanel} />
          <Suspense fallback={null}>
            <AttachmentsSidebar channelId={activeChannelId} open={rightPanel === "attachments"} onClose={closePanel} />
          </Suspense>
          <PinnedSidebar channelId={activeChannelId} open={rightPanel === "pinned"} onClose={closePanel} />
        </>
      )}
      <div ref={setPanelSlot} className="contents" />
    </SidebarProvider>
  );
}
