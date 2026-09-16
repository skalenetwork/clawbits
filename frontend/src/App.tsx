import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "./components/Icon";
import { queryClient } from "./lib/queryClient";
import { AuthProvider } from "./context/AuthContext";
import { useGlobalEvents } from "./hooks/useGlobalEvents";
import { useViewportVars } from "./hooks/useViewportVars";
import { ThemeProvider } from "./hooks/useTheme";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "./components/ui/sonner";
import { ConfirmHost } from "./lib/ConfirmHost";
import AppLayout from "./layouts/AppShell";
import GuestOnly from "./components/GuestOnly";
import RequireAuth from "./components/RequireAuth";
import { ScrollToTop } from "./components/ScrollToTop";
import { AgentShell } from "./components/agent/AgentShell";
import { AgentTabs } from "./components/agent/AgentTabs";
import { DesktopTitleBar } from "./components/DesktopTitleBar";
import { useDesktopNav } from "./hooks/useDesktopNav";
import { Analytics } from "./components/Analytics";
import { ShortcutProvider } from "./lib/shortcuts";
import { CommandPalette } from "./components/command/CommandPalette";
import { CreateDialogs } from "./components/command/CreateDialogs";
import { UpdateProvider } from "./context/UpdateContext";

const loadAgentHomePage = () => import("./pages/AgentHomePage");
const loadChannelPage = () => import("./pages/ChannelPage");
const LoginPage = lazy(() => import("./pages/LoginPage"));
const VerifyEmailPage = lazy(() => import("./pages/VerifyEmailPage"));
const ReefSetupPage = lazy(() => import("./pages/ReefSetupPage"));
const AgentSetupPage = lazy(() => import("./pages/AgentSetupPage"));
const OrgSetupPage = lazy(() => import("./pages/OrgSetupPage"));
const TermsPage = lazy(() => import("./pages/TermsPage"));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage"));
const AgentCardPage = lazy(() => import("./pages/AgentCardPage"));
const AgentInboxPage = lazy(() => import("./pages/AgentInboxPage"));
const AgentAutomationsPage = lazy(() => import("./pages/AgentAutomationsPage"));
const AgentManagePage = lazy(() => import("./pages/AgentManagePage"));
const AgentHomePage = lazy(loadAgentHomePage);
const ChannelPage = lazy(loadChannelPage);
const OrgMembersPage = lazy(() => import("./pages/OrgMembersPage"));
const OrgUsagePage = lazy(() => import("./pages/OrgUsagePage"));
const SettingsMenuPage = lazy(() => import("./pages/SettingsMenuPage"));
const SettingsProfilePage = lazy(() => import("./pages/SettingsProfilePage"));
const SettingsConnectorsPage = lazy(() => import("./pages/SettingsConnectorsPage"));
const SettingsAppearancePage = lazy(() => import("./pages/SettingsAppearancePage"));
const SettingsPrivacyPage = lazy(() => import("./pages/SettingsPrivacyPage"));
const SettingsNotificationsPage = lazy(() => import("./pages/SettingsNotificationsPage"));
const SettingsOrganizationPage = lazy(() => import("./pages/SettingsOrganizationPage"));
const AgentsPage = lazy(() => import("./pages/AgentsPage"));
const SettingsChannelsPage = lazy(() => import("./pages/SettingsChannelsPage"));
const SettingsLobstertalkPage = lazy(() => import("./pages/SettingsLobstertalkPage"));
const SettingsReefPage = lazy(() => import("./pages/SettingsReefPage"));
const AgentSkillsPage = lazy(() => import("./pages/AgentSkillsPage"));
const SkillDetailPage = lazy(() => import("./pages/SkillDetailPage"));
const SkillsPage = lazy(() => import("./pages/SkillsPage"));

// A cold load starts its landing page's chunk alongside the auth check, so the page is ready when the shell mounts.
if (window.location.pathname.startsWith("/channels/")) void loadChannelPage();
else if (["/", "/home"].includes(window.location.pathname)) void loadAgentHomePage();

function AppShell() {
  useDesktopNav();
  useGlobalEvents();
  return (
    <>
      <Analytics />
      <DesktopTitleBar />
      <ScrollToTop />
      <CommandPalette />
      <CreateDialogs />
      <Suspense
        fallback={
          <div className="flex min-h-dvh items-center justify-center">
            <Icon icon={Loading02Icon} className="size-5 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <Routes>
          <Route element={<GuestOnly />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/verify-email" element={<VerifyEmailPage />} />
          </Route>
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/setup/reef" element={<ReefSetupPage />} />
            <Route path="/setup/agent" element={<AgentSetupPage />} />
            <Route path="/setup/org" element={<OrgSetupPage />} />
          </Route>
          <Route element={<AppLayout />}>
            <Route path="/home" element={<AgentHomePage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/:agentId" element={<AgentShell />}>
              <Route element={<AgentTabs />}>
                <Route index element={<Navigate to="card" replace />} />
                <Route path="automations/:automationId?" element={<AgentAutomationsPage />} />
                <Route path="inbox/:uid?" element={<AgentInboxPage />} />
                <Route path="card" element={<AgentCardPage />} />
                <Route path="manage" element={<AgentManagePage />} />
              </Route>
              <Route path="skills" element={<AgentSkillsPage />} />
            </Route>
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/skills/:skillId" element={<SkillDetailPage />} />
            <Route path="/channels/:channelId" element={<ChannelPage />} />
            <Route path="/settings" element={<SettingsMenuPage />} />
            <Route path="/settings/profile" element={<SettingsProfilePage />} />
            <Route path="/settings/connectors" element={<SettingsConnectorsPage />} />
            <Route path="/settings/privacy" element={<SettingsPrivacyPage />} />
            <Route path="/settings/appearance" element={<SettingsAppearancePage />} />
            <Route path="/settings/notifications" element={<SettingsNotificationsPage />} />
            <Route path="/settings/organization" element={<SettingsOrganizationPage />} />
            <Route path="/settings/members" element={<OrgMembersPage />} />
            <Route path="/settings/usage" element={<OrgUsagePage />} />
            <Route path="/settings/channels" element={<SettingsChannelsPage />} />
            <Route path="/settings/lobstertalk" element={<SettingsLobstertalkPage />} />
            <Route path="/settings/reef" element={<SettingsReefPage />} />
            {/* agent_signup.py mints this path into every approval_url. */}
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
        </AuthProvider>
        {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
      </QueryClientProvider>
    </ThemeProvider>
  );
}
