import { lazy, Suspense, useMemo } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "./components/Icon";
import { queryClient } from "./lib/queryClient";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { useGlobalEvents } from "./hooks/useGlobalEvents";
import { selfMentionTokens } from "./lib/mentions";
import { useViewportVars } from "./hooks/useViewportVars";
import { ThemeProvider } from "./hooks/useTheme";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "./components/ui/sonner";
import { ConfirmHost } from "./lib/ConfirmHost";
import { UserPresenceProvider } from "./components/UserPresenceProvider";
import { AgentPresenceProvider } from "./components/AgentPresenceProvider";
import AppLayout from "./layouts/AppShell";
import GuestOnly from "./components/GuestOnly";
import { ScrollToTop } from "./components/ScrollToTop";
import { AgentShell } from "./components/agent/AgentShell";
import { DesktopTitleBar } from "./components/DesktopTitleBar";
import { useDesktopNav } from "./hooks/useDesktopNav";
import { Analytics } from "./components/Analytics";
import { ShortcutProvider } from "./lib/shortcuts";
import { CommandPalette } from "./components/command/CommandPalette";
import { CreateDialogs } from "./components/command/CreateDialogs";
import { UpdateProvider } from "./context/UpdateContext";

// One chunk per route: the entry bundle carries the shell, the providers and
// the shared libraries, and a page's code arrives when it is first visited.
// Navigations run inside a transition, so the current screen stays put while
// the next one loads and the fallback is only ever seen on a cold load.
const LoginPage = lazy(() => import("./pages/LoginPage"));
const VerifyEmailPage = lazy(() => import("./pages/VerifyEmailPage"));
const TermsPage = lazy(() => import("./pages/TermsPage"));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage"));
const ChangelogPage = lazy(() => import("./pages/ChangelogPage"));
const AgentCardPage = lazy(() => import("./pages/AgentCardPage"));
const AgentInboxPage = lazy(() => import("./pages/AgentInboxPage"));
const AgentAutomationsPage = lazy(() => import("./pages/AgentAutomationsPage"));
const AgentAutomationDetailPage = lazy(() => import("./pages/AgentAutomationDetailPage"));
const AgentManagePage = lazy(() => import("./pages/AgentManagePage"));
const AgentHomePage = lazy(() => import("./pages/AgentHomePage"));
const ChannelPage = lazy(() => import("./pages/ChannelPage"));
const OrgMembersPage = lazy(() => import("./pages/OrgMembersPage"));
const OrgUsagePage = lazy(() => import("./pages/OrgUsagePage"));
const SettingsMenuPage = lazy(() => import("./pages/SettingsMenuPage"));
const SettingsProfilePage = lazy(() => import("./pages/SettingsProfilePage"));
const SettingsConnectorsPage = lazy(() => import("./pages/SettingsConnectorsPage"));
const SettingsAppearancePage = lazy(() => import("./pages/SettingsAppearancePage"));
const SettingsPrivacyPage = lazy(() => import("./pages/SettingsPrivacyPage"));
const SettingsNotificationsPage = lazy(() => import("./pages/SettingsNotificationsPage"));
const SettingsAgentsPage = lazy(() => import("./pages/SettingsAgentsPage"));
const SettingsChannelsPage = lazy(() => import("./pages/SettingsChannelsPage"));
const SettingsLobstertalkPage = lazy(() => import("./pages/SettingsLobstertalkPage"));
const SettingsReefPage = lazy(() => import("./pages/SettingsReefPage"));
const AutomationsPage = lazy(() => import("./pages/AutomationsPage"));
const AgentSkillsPage = lazy(() => import("./pages/AgentSkillsPage"));
const SkillDetailPage = lazy(() => import("./pages/SkillDetailPage"));
const SkillsPage = lazy(() => import("./pages/SkillsPage"));
const AutomationDetailPage = lazy(() => import("./pages/AutomationDetailPage"));

/**
 * App-level realtime subscription. Mounted once inside the router (above every
 * route) so the per-user SSE stream — new-message events, sidebar unread
 * counts, cross-tab read/mute sync, channel add/remove — stays connected on
 * EVERY page (home, social, settings, agent profiles…), not just inside
 * the app shell. Gated on auth, so it stays idle on the login/public routes.
 */
function GlobalRealtime() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const activeChannelId = /^\/channels\/([^/]+)/.exec(location.pathname)?.[1] ?? null;
  // Stable per-user token set so the SSE handler can flag posts that mention
  // the viewer (or @here) and bump the sidebar's mention badge live.
  const selfTokens = useMemo(() => selfMentionTokens(user), [user]);
  useGlobalEvents({
    currentUserId: user?.id ?? null,
    selfMentionTokens: selfTokens,
    activeChannelId,
    enabled: Boolean(user),
    onChannelRemoved: () => { void navigate("/home"); },
  });
  return null;
}

function RouteFallback() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Icon icon={Loading02Icon} className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}

function AppShell() {
  useDesktopNav();
  return (
    <>
      <Analytics />
      <DesktopTitleBar />
      <ScrollToTop />
      <GlobalRealtime />
      <CommandPalette />
      <CreateDialogs />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route element={<GuestOnly />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/verify-email" element={<VerifyEmailPage />} />
          </Route>
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/changelog" element={<ChangelogPage />} />
          <Route element={<AppLayout />}>
            <Route path="/home" element={<AgentHomePage />} />
            <Route path="/agents" element={<SettingsAgentsPage />} />
            {/* One layout route fetches the agent profile once + shares it with
                every subpage; the four pages keep their own URLs (deep links) but
                shed the per-page sanitize/query/guard boilerplate. */}
            <Route path="/agents/:agentId" element={<AgentShell />}>
              <Route index element={<AgentCardPage />} />
              {/* Optional :uid — the open message lives in the URL; one route
                  object means selection changes never remount the page. */}
              <Route path="inbox/:uid?" element={<AgentInboxPage />} />
              <Route path="automations" element={<AgentAutomationsPage />} />
              <Route path="automations/:automationId" element={<AgentAutomationDetailPage />} />
              <Route path="skills" element={<AgentSkillsPage />} />
              <Route path="manage" element={<AgentManagePage />} />
            </Route>
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/skills/:skillId" element={<SkillDetailPage />} />
            <Route path="/automations" element={<AutomationsPage />} />
            <Route path="/automations/:automationId" element={<AutomationDetailPage />} />
            <Route path="/channels/:channelId" element={<ChannelPage />} />
            <Route path="/settings" element={<SettingsMenuPage />} />
            <Route path="/settings/profile" element={<SettingsProfilePage />} />
            <Route path="/settings/connectors" element={<SettingsConnectorsPage />} />
            <Route path="/settings/privacy" element={<SettingsPrivacyPage />} />
            <Route path="/settings/appearance" element={<SettingsAppearancePage />} />
            <Route path="/settings/notifications" element={<SettingsNotificationsPage />} />
            <Route path="/settings/members" element={<OrgMembersPage />} />
            <Route path="/settings/usage" element={<OrgUsagePage />} />
            <Route path="/settings/channels" element={<SettingsChannelsPage />} />
            <Route path="/settings/lobstertalk" element={<SettingsLobstertalkPage />} />
            <Route path="/settings/reef" element={<SettingsReefPage />} />
            {/* NOT dead: agent_signup.py mints this exact path into every
                approval_url. Remove only after the backend mints /agents
                and no in-flight approval links remain. */}
            <Route path="/settings/agents" element={<Navigate to="/agents" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}

export default function App() {
  useViewportVars();
  return (
    <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <UserPresenceProvider>
        <AgentPresenceProvider>
        <TooltipProvider>
          <Toaster />
          <ConfirmHost />
          <BrowserRouter>
            <ShortcutProvider>
              <UpdateProvider>
                <AppShell />
              </UpdateProvider>
            </ShortcutProvider>
          </BrowserRouter>
        </TooltipProvider>
        </AgentPresenceProvider>
        </UserPresenceProvider>
      </AuthProvider>
      {/* Explicit DEV literal so the bundler drops this from production: the
          devtools panel renders the whole query cache, reef reads included. */}
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
    </ThemeProvider>
  );
}
