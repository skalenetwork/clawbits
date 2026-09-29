import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import { listMmChannels } from "@/lib/api";
import { setDesktopUnread } from "@/lib/desktop";
import { channelLabel } from "@/lib/chatFilters";
import {
  isPushSupported,
  refreshPushOnLoad,
  registerPushServiceWorker,
  setupPushClickNavigation,
} from "@/lib/push";
import { useHeartbeat } from "@/hooks/useHeartbeat";
import { hasUnseenRelease } from "@/hooks/useReleaseNotes";
import { queryKeys } from "@/lib/queryKeys";
import { useIsMobile } from "@/hooks/use-mobile";
import { DesktopShell } from "./DesktopShell";
import { MobileShell } from "./MobileShell";
import { captureReturnPath, withNext } from "@/lib/returnPath";

const ReleaseNotesCard = lazy(() =>
  import("@/components/ReleaseNotesCard").then((module) => ({ default: module.ReleaseNotesCard })),
);

/** Right-edge panels on desktop, bottom sheets on mobile; one open at a time. */
export type ChannelPanel = "info" | "attachments" | "pinned";

export interface ChannelOutletContext {
  panel: ChannelPanel | null;
  togglePanel: (panel: ChannelPanel) => void;
}

/** The menu bar icon's menu lists at most this many unread channels. */
const TRAY_UNREAD_LIMIT = 8;

/** Auth gating, the unread title and dock badge, heartbeat and web push, then the desktop or mobile layout. */
export default function AppShell() {
  const { user, activeOrgId, needsOrgPick, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [releaseNotesDue] = useState(hasUnseenRelease);

  const channelsQuery = useQuery({
    queryKey: queryKeys.mm.channels(activeOrgId),
    queryFn: () => listMmChannels(activeOrgId),
    enabled: Boolean(activeOrgId),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  useHeartbeat(Boolean(user));

  const channels = channelsQuery.data?.channels;
  useEffect(() => {
    const unread = (channels ?? []).filter((c) => !c.muted && (c.unread_count ?? 0) > 0);
    const total = unread.reduce((sum, c) => sum + (c.unread_count ?? 0), 0);
    const badge = total > 99 ? "99+" : String(total);
    document.title = total > 0 ? `(${badge}) Clawbits` : "Clawbits";
    setDesktopUnread(
      total > 0 ? badge : undefined,
      unread.slice(0, TRAY_UNREAD_LIMIT).map((c) => ({
        name: `${channelLabel(c)} (${String(c.unread_count)})`,
        path: `/channels/${c.channel_id}`,
      })),
    );
  }, [channels]);
  useEffect(() => () => { setDesktopUnread(undefined, []); }, []);

  useEffect(() => {
    if (!isPushSupported()) return;
    void registerPushServiceWorker();
    if (user) void refreshPushOnLoad();
    return setupPushClickNavigation((url) => { void navigate(url); });
  }, [user, navigate]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!user) return <Navigate to={withNext("/login", captureReturnPath(location))} replace />;
  if (needsOrgPick) return <Navigate to={withNext("/setup/org", captureReturnPath(location))} replace />;

  return (
    <>
      {isMobile ? <MobileShell /> : <DesktopShell />}
      {releaseNotesDue && (
        <Suspense fallback={null}>
          <ReleaseNotesCard />
        </Suspense>
      )}
    </>
  );
}
