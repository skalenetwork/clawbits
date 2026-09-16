import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import { listMmChannels } from "@/lib/api";
import { setDockBadge } from "@/lib/desktop";
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

  const totalUnread = (channelsQuery.data?.channels ?? []).reduce(
    (sum, c) => (c.muted ? sum : sum + (c.unread_count ?? 0)),
    0,
  );
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread > 99 ? "99+" : String(totalUnread)}) Clawbits` : "Clawbits";
    void setDockBadge(totalUnread);
  }, [totalUnread]);
  useEffect(() => () => { void setDockBadge(0); }, []);

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
