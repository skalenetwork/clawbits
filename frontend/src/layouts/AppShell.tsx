import { useEffect } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import { listMmChannels } from "@/lib/api";
import { totalUnreadFromChannels } from "@/hooks/useGlobalEvents";
import { setDockBadge } from "@/lib/desktop";
import {
  isPushSupported,
  refreshPushOnLoad,
  registerPushServiceWorker,
  setupPushClickNavigation,
} from "@/lib/push";
import { useHeartbeat } from "@/hooks/useHeartbeat";
import { ReleaseNotesDialog } from "@/components/ReleaseNotesDialog";
import { queryKeys } from "@/lib/queryKeys";
import { useIsMobile } from "@/hooks/use-mobile";
import { DesktopShell } from "./DesktopShell";
import { MobileShell } from "./MobileShell";
import { captureReturnPath, loginPathFor } from "@/lib/returnPath";

/** Outlet context delivered to channel routes — lets the channel-page header
 *  pill toggle the right-rail details panel. Provided only by the desktop
 *  shell for now; the mobile members/pins drawer is a later phase, and
 *  ChannelPage reads this context optionally so its absence is safe. */
export interface ChannelOutletContext {
  chatInfoOpen: boolean;
  toggleChatInfo: () => void;
  /** Right-edge Attachments panel — mutually exclusive with chat-info. */
  attachmentsOpen: boolean;
  toggleAttachments: () => void;
}

/**
 * The app shell ORCHESTRATOR. It owns the concerns shared by every viewport —
 * auth gating, the channels query that drives the tab-title counter + macOS
 * dock badge, presence heartbeat, and web-push registration — then branches the
 * LAYOUT on viewport size: the desktop rail+card shell, or the mobile
 * edge-to-edge stack with a floating bottom nav. ``useIsMobile()`` is seeded
 * pre-paint from ``html[data-viewport]`` (see lib/viewport.ts), so the first
 * render already picks the right shell — no flash, no double-mount.
 */
export default function AppShell() {
  const { user, activeOrgId, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();

  // Drives the tab-title counter + macOS dock badge. SSE (useGlobalEvents at
  // the app root) is the fast path; this poll is the safety net for events
  // missed during a stream reconnect. Shares its cache key with the Chats
  // sidebar, so there's no double fetch.
  const channelsQuery = useQuery({
    queryKey: queryKeys.mm.channels(activeOrgId ?? null),
    queryFn: () => listMmChannels(activeOrgId ?? null),
    enabled: Boolean(activeOrgId),
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  // Drive the current user's own online/idle/offline presence. Gated on auth.
  useHeartbeat(Boolean(user));

  const totalUnread = totalUnreadFromChannels(
    channelsQuery.data?.channels ?? [],
  );
  useEffect(() => {
    const base = "Clawbits";
    document.title =
      totalUnread > 0
        ? `(${totalUnread > 99 ? "99+" : String(totalUnread)}) ${base}`
        : base;
    void setDockBadge(totalUnread);
  }, [totalUnread]);
  // Clear badge on logout / unmount so it doesn't persist across sessions.
  useEffect(
    () => () => {
      void setDockBadge(0);
    },
    [],
  );

  // Web push: re-assert subscription for opted-in users + route on click.
  // No-op on desktop and on unsupported/insecure contexts.
  useEffect(() => {
    if (!isPushSupported()) return;
    void registerPushServiceWorker();
    if (user) void refreshPushOnLoad();
    return setupPushClickNavigation((url) => {
      void navigate(url);
    });
  }, [user, navigate]);

  if (loading)
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );

  // Carry the requested path across the login round-trip. Every flow reads
  // it back on success; see lib/returnPath.ts for why it is validated rather
  // than trusted.
  if (!user) return <Navigate to={loginPathFor(captureReturnPath(location))} replace />;

  return (
    <>
      {isMobile ? <MobileShell /> : <DesktopShell />}
      <ReleaseNotesDialog />
    </>
  );
}
