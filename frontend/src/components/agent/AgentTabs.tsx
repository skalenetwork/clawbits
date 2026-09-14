import { useMutation, useQuery } from "@tanstack/react-query";
import { Navigate, NavLink, Outlet, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { BubbleChatIcon, Clock05Icon, IdentityCardIcon, Mail01Icon, Settings02Icon } from "@hugeicons/core-free-icons";
import { Icon, type AppIcon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import type { AgentOutletContext } from "@/components/agent/AgentShell";
import { agentBreadcrumbs } from "@/components/agent/agentBreadcrumbs";
import type { AgentTabContext } from "@/components/agent/agentTabContext";
import { useAgentInboxCount } from "@/components/agent/inbox/useInbox";
import { SettingsPage, SettingsRow, SettingsRowSkeleton, SettingsSection } from "@/components/settings/Settings";
import { Button } from "@/components/ui/button";
import { createOrGetMmDirect, listAgentAutomations, type AgentProfile } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type AgentTab = "automations" | "inbox" | "card" | "manage";

const TABS: { key: AgentTab; label: string; icon: AppIcon }[] = [
  { key: "card", label: "Card", icon: IdentityCardIcon },
  { key: "automations", label: "Automations", icon: Clock05Icon },
  { key: "inbox", label: "Inbox", icon: Mail01Icon },
  { key: "manage", label: "Manage", icon: Settings02Icon },
];

const TAB =
  "flex h-[30px] min-w-0 items-center justify-center gap-[7px] rounded-lg px-2 text-[13px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50";

function allowedTabs(profile: AgentProfile): AgentTab[] {
  if (profile.is_operator) return ["automations", "inbox", "card", "manage"];
  return profile.can_manage_contacts ? ["card", "manage"] : ["card"];
}

export function AgentTabs() {
  const { orgId, agentId, profile, isError } = useOutletContext<AgentOutletContext>();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const id = agentId ?? "";
  const operator = Boolean(profile?.is_operator);

  const automationsQuery = useQuery({
    queryKey: queryKeys.automationsForAgent(orgId, id),
    queryFn: () => listAgentAutomations(orgId, id),
    enabled: operator,
  });
  const inboxQuery = useAgentInboxCount(orgId, id, operator);
  const openChat = useMutation({
    mutationFn: () => createOrGetMmDirect(orgId, "agent", id),
    onSuccess: (channel) => {
      void navigate(`/channels/${channel.channel_id}`);
    },
    onError: (err) => {
      toast.error(errMsg(err, "Couldn't open chat"));
    },
  });

  const allowed = profile ? allowedTabs(profile) : [];
  const active = pathname.split("/")[3];
  if (profile && active && !allowed.some((tab) => tab === active)) return <Navigate to="card" replace />;

  const counts: Partial<Record<AgentTab, number>> = {
    automations: automationsQuery.data?.automations.length,
    inbox: inboxQuery.data?.unread,
  };
  const operatorName = profile?.operator?.display_name ?? "the operator";

  return (
    <SettingsPage>
      <PageHeader
        breadcrumb={agentBreadcrumbs(agentId, profile)}
        actions={
          profile?.can_dm && (
            <Button
              variant="ghost"
              size="compact"
              disabled={openChat.isPending}
              onClick={() => {
                openChat.mutate();
              }}
            >
              <Icon icon={BubbleChatIcon} />
              Chat
            </Button>
          )
        }
      />
      {profile && agentId ? (
        <>
          <nav
            aria-label="Agent"
            className="relative z-10 grid grid-cols-4 gap-0.5 rounded-[11px] bg-[color-mix(in_oklab,var(--foreground)_5%,var(--background))]/60 p-[3px] backdrop-blur-sm"
          >
            {TABS.map(({ key, label, icon }) => {
              const inner = (
                <>
                  <Icon icon={icon} className="size-[15px] shrink-0 max-sm:hidden" />
                  <span className="truncate">{label}</span>
                  {counts[key] ? (
                    <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-foreground/8 px-[5px] text-[11px] leading-none font-medium text-muted-foreground tabular-nums">
                      {counts[key]}
                    </span>
                  ) : null}
                </>
              );
              return allowed.includes(key) ? (
                <NavLink
                  key={key}
                  to={key}
                  replace
                  className={({ isActive }) =>
                    cn(
                      TAB,
                      isActive
                        ? "bg-background text-foreground shadow-[0_1px_2px_oklch(0_0_0/0.07),0_0_0_0.5px_oklch(0_0_0/0.08)] dark:bg-foreground/12 dark:shadow-none"
                        : "text-muted-foreground hover:text-foreground",
                    )
                  }
                >
                  {inner}
                </NavLink>
              ) : (
                <span
                  key={key}
                  role="link"
                  aria-disabled="true"
                  title={`Only ${operatorName}${key === "manage" ? " or an org owner" : ""} can open ${label}`}
                  className={cn(TAB, "cursor-not-allowed text-muted-foreground opacity-40")}
                >
                  {inner}
                </span>
              );
            })}
          </nav>
          <Outlet context={{ orgId, agentId, profile } satisfies AgentTabContext} />
        </>
      ) : (
        <SettingsSection>
          {isError ? (
            <SettingsRow title="Couldn't load this agent" />
          ) : (
            [0, 1, 2].map((i) => <SettingsRowSkeleton key={i} />)
          )}
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
