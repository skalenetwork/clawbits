import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Add01Icon,
  CompassIcon,
  HashtagIcon,
  MessageAdd01Icon,
  Robot02Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

import { Icon } from "@/components/Icon";
import { cn } from "@/lib/utils";
import { openCommandPalette } from "@/components/command/paletteStore";
import { MOBILE_TABS, showMobileNav } from "@/lib/navSections";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { openCreate } from "@/components/command/createStore";

/**
 * Floating liquid-glass bottom navigation for mobile: ONE pill holding the
 * tabs (Chats · Agents · You) plus a Search action, and, beside it, a SEPARATE
 * circular compose button at the same height + icon size — the iOS 26/27 navbar
 * shape. Search opens the command palette (a full-screen overlay) rather than
 * navigating, so it is never "active"; it lives here instead of the top bar so
 * the floating header can stay a slim title strip.
 *
 * Glass tiering: a translucent fill + backdrop blur/saturate where the engine
 * supports it, with the opaque ``bg-popover`` base as the @supports fallback so
 * the bar stays legible in Firefox / WebKitGTK. Hidden on pushed/full-screen
 * routes (a channel or agent profile) so the conversation is edge-to-edge.
 */
export function MobileBottomNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  if (!showMobileNav(pathname)) return null;

  return (
    // ``absolute`` within the fixed-viewport shell (its containing block), so the
    // bar is rock-stable — no document scroll to pan it, no visual-viewport
    // gymnastics. Row is pointer-events-none so taps fall through the gaps to
    // content; the pill + FAB re-enable pointer events on themselves.
    //
    // Lifted off the true bottom edge by the safe-area inset (clears the home
    // indicator in the installed PWA; ~0.5rem in a browser tab).
    <div className="pointer-events-none absolute inset-x-0 bottom-[max(0.5rem,calc(var(--safe-bottom)-0.5rem))] z-40 flex items-center justify-center gap-2.5 px-4">
      <nav
        aria-label="Primary"
        data-glass
        // Full pill (rounded-full) with a tight, equal 4px inset (p-1) around a
        // taller 52px tab cluster — keeps the overall ~60px pill height while
        // giving each tab more internal room.
        className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/40 bg-popover/85 p-1 shadow-lg ring-1 ring-foreground/[0.04] supports-backdrop-filter:bg-popover/60 supports-backdrop-filter:backdrop-blur-2xl supports-backdrop-filter:backdrop-saturate-150"
      >
        {MOBILE_TABS.map((tab) => {
          const active = tab.match(pathname);
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                void navigate(tab.path, { viewTransition: true });
              }}
              aria-label={tab.label}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-13 w-14 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] font-medium transition active:scale-95",
                active
                  ? "bg-foreground/[0.08] text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <Icon icon={tab.icon} className="size-[22px]" />
              <span className="leading-none">{tab.label}</span>
            </button>
          );
        })}

        {/* Search is an action (opens the command palette overlay), not a
            route — same look as a tab, but never the active one. */}
        <button
          type="button"
          onClick={() => {
            openCommandPalette();
          }}
          aria-label="Search"
          className="flex h-13 w-14 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] font-medium text-muted-foreground transition active:scale-95"
        >
          <Icon icon={Search01Icon} className="size-[22px]" />
          <span className="leading-none">Search</span>
        </button>
      </nav>

      <MobileComposeButton />
    </div>
  );
}

/** One row inside the compose sheet: tinted icon square + title over a hint. */
function ComposeRow({
  icon,
  square,
  color,
  title,
  description,
  onSelect,
}: {
  icon: IconSvgElement;
  square: string;
  color: string;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition active:scale-[0.99] active:bg-foreground/5"
    >
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${square}`}
      >
        <Icon icon={icon} className="size-5" style={{ color }} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

/**
 * The separate compose action beside the tab pill. Opens a bottom sheet of
 * create options, each of which launches the existing create dialog — so the
 * mobile compose flow reuses the exact same forms as the desktop rail menu.
 */
function MobileComposeButton() {
  const [sheetOpen, setSheetOpen] = useState(false);

  // Close the sheet, then open the shared create dialog (mounted once in the
  // app shell via CreateDialogs). openCreate defers to the next task, so the
  // sheet's dismissal and the dialog's mount don't fight over the same tap.
  const pick = (kind: Parameters<typeof openCreate>[0]) => {
    setSheetOpen(false);
    openCreate(kind);
  };

  return (
    <>
      <button
        type="button"
        aria-label="Compose"
        onClick={() => {
          setSheetOpen(true);
        }}
        className="pointer-events-auto flex size-[60px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg ring-1 ring-foreground/[0.06] transition active:scale-90"
      >
        <Icon icon={Add01Icon} className="size-[22px]" />
      </button>

      <Drawer open={sheetOpen} onOpenChange={setSheetOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Create</DrawerTitle>
          </DrawerHeader>
          <div className="flex flex-col gap-0.5 pb-2">
            <ComposeRow
              icon={MessageAdd01Icon}
              square="bg-blue-500/15"
              color="var(--color-blue-500)"
              title="Open DM"
              description="Start a private conversation"
              onSelect={() => {
                pick("dm");
              }}
            />
            <ComposeRow
              icon={HashtagIcon}
              square="bg-emerald-500/15"
              color="var(--color-emerald-500)"
              title="New channel"
              description="Start a group conversation by topic"
              onSelect={() => {
                pick("channel");
              }}
            />
            <ComposeRow
              icon={CompassIcon}
              square="bg-amber-500/15"
              color="var(--color-amber-500)"
              title="Join channel"
              description="Browse public channels in your org"
              onSelect={() => {
                pick("browse");
              }}
            />
            <ComposeRow
              icon={Robot02Icon}
              square="bg-violet-500/15"
              color="var(--color-violet-500)"
              title="New agent"
              description="Create an AI teammate"
              onSelect={() => {
                pick("agent");
              }}
            />
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
