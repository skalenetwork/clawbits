/**
 * Settings → Reef: the machines pulling from the org's repository.
 *
 * First run lives in the full-screen wizard at ``/setup/reef``, which owns the
 * repository form and the bootstrap command. What is left here is the roster.
 *
 * Nothing on this page reaches a host. A host exists because its status file
 * does, and the reconciler commits that file only when its bytes change, so a
 * calm machine and a stopped one are indistinguishable from here. Liveness is
 * therefore asserted only from positive evidence, and the absence of it is
 * called quiet, never stopped.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ServerStack01Icon as ServerStack } from "@hugeicons/core-free-icons";
import { PageHeader } from "@/components/PageHeader";
import { SetupMark } from "@/components/setup/SetupShell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/context/AuthContext";
import { useActiveOrg } from "@/hooks/useActiveOrg";
import { agentLivenessStatus } from "@/lib/agentLiveness";
import { deleteReef, getAgents, getReef, type AgentUser, type ReefHost } from "@/lib/api";
import { confirm } from "@/lib/confirm";
import { formatRelativeAgo, parseUtcTimestamp } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** One reconcile tick plus margin: inside it, a push proves the timer ran. */
const LIVE_PUSH_MS = 2 * 60_000;

const ICON = { machine: "/computer.webp", host: "/server.webp", repo: "/github.webp" };

/**
 * Positive evidence that a machine is up, from two independent clocks: the
 * last push, which proves the reconciler ran, and any agent on it pinging
 * clawbits directly, which proves the machine is running work whatever git
 * says. Either is proof; neither is disproof.
 */
function liveness(host: ReefHost, agents: AgentUser[], now: number) {
  // The backend serializes naive UTC, so a bare Date.parse would read a fresh
  // push as hours old for anyone ahead of UTC.
  const pushed = host.last_seen ? parseUtcTimestamp(host.last_seen).getTime() : NaN;
  if (!Number.isNaN(pushed) && now - pushed <= LIVE_PUSH_MS) {
    return { live: true, detail: `Reported ${formatRelativeAgo(host.last_seen)}.` };
  }
  const pinged = agents.find(
    (a) =>
      a.reef_host === host.host &&
      agentLivenessStatus(a.last_alive_at ?? null, now) === "available",
  );
  if (pinged) {
    return {
      live: true,
      detail: `An agent here pinged ${formatRelativeAgo(pinged.last_alive_at)}.`,
    };
  }
  return {
    live: false,
    detail: host.last_seen
      ? `Last reported ${formatRelativeAgo(host.last_seen)}. A machine reports only when something changes.`
      : "This machine has not reported yet.",
  };
}

export default function SettingsReefPage() {
  const { activeOrgId } = useAuth();
  const { isOwner } = useActiveOrg();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const reefQuery = useQuery({
    queryKey: activeOrgId ? queryKeys.reef(activeOrgId) : ["org", "none", "reef"],
    queryFn: () => getReef(activeOrgId ?? ""),
    enabled: Boolean(activeOrgId),
    // Each poll costs one GitHub call per host, so it runs while the page is
    // actually being looked at and stops when it is not.
    refetchInterval: 30_000,
  });
  const reef = reefQuery.data;

  // The second liveness clock, already cached by the rest of the app.
  const agentsQuery = useQuery({
    queryKey: activeOrgId ? queryKeys.agents(activeOrgId) : ["agents", "none"],
    queryFn: () => getAgents(activeOrgId ?? ""),
    enabled: Boolean(activeOrgId) && Boolean(reef?.connected),
  });
  const agents = agentsQuery.data?.agents ?? [];

  const disconnect = useMutation({
    mutationFn: () => deleteReef(activeOrgId ?? ""),
    onSuccess: () => {
      if (activeOrgId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.reef(activeOrgId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.orgs });
      }
      toast.success("Repository disconnected");
    },
    onError: (e) => {
      toast.error(errMsg(e, "Couldn't disconnect the repository"));
    },
  });

  if (!activeOrgId) {
    return <div className="text-sm text-muted-foreground">Select an organization.</div>;
  }

  const toSetup = () => {
    void navigate("/setup/reef");
  };
  const hosts = reef?.hosts ?? [];
  /** Stored, but the token can no longer be unsealed. A new one is the fix. */
  const needsToken = Boolean(reef && !reef.connected && reef.repo);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ServerStack}
        title="Reef"
        count={hosts.length || undefined}
        actions={
          isOwner && reef?.connected ? (
            <Button variant="outline" size="sm" onClick={toSetup}>
              Add machine
            </Button>
          ) : null
        }
      />

      {reefQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-[66px] rounded-2xl" />
          <Skeleton className="h-[66px] rounded-2xl" />
        </div>
      ) : reefQuery.isError ? (
        <p className="text-sm text-destructive">
          {errMsg(reefQuery.error, "Couldn't load your machines")}
        </p>
      ) : !reef?.connected ? (
        <Panel
          title={needsToken ? "This repository needs a new token" : "No repository connected"}
          line={
            needsToken
              ? "The stored token can no longer be read, so clawbits cannot reach the repository."
              : isOwner
                ? "Reef runs your agents on your own machines. Connect a private repository to start."
                : "An organization admin can connect one."
          }
          action={
            isOwner
              ? { label: needsToken ? "Reconnect" : "Connect a repository", run: toSetup }
              : undefined
          }
        />
      ) : hosts.length === 0 ? (
        <Panel
          title="No machine has reported yet"
          line="Run the setup on a machine and it appears here on its own."
          action={isOwner ? { label: "Add machine", run: toSetup } : undefined}
        />
      ) : (
        <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-card">
          {hosts.map((h) => (
            <HostRow key={h.host} host={h} agents={agents} now={reefQuery.dataUpdatedAt} />
          ))}
        </div>
      )}

      {reef?.repo && (
        <div className="flex items-start gap-2.5 border-t border-border/60 pt-4">
          <img src={ICON.repo} alt="" className="size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <a
              href={`https://github.com/${reef.repo}`}
              target="_blank"
              rel="noreferrer"
              className="text-[13px] font-medium break-all hover:underline"
            >
              {reef.repo}
            </a>
            <p className="text-xs text-muted-foreground">
              Machines pull every 30 seconds and report only when something changes.
            </p>
          </div>
          {isOwner && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disconnect.isPending}
              onClick={() => {
                void confirm({
                  title: "Disconnect the repository?",
                  description:
                    "Agents already declared keep running: their files stay on the branch. Clawbits just stops reading and writing it.",
                  confirmLabel: "Disconnect",
                  destructive: true,
                }).then((ok) => {
                  if (ok) disconnect.mutate();
                });
              }}
            >
              Disconnect
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** One machine. The dot is filled only on proof, so a quiet row is a normal
 *  row rather than a warning. */
function HostRow({
  host,
  agents,
  now,
}: {
  host: ReefHost;
  agents: AgentUser[];
  /** When the roster was fetched. Liveness reads off that rather than the
   *  clock, so render stays pure and the row cannot disagree with its data. */
  now: number;
}) {
  const { live, detail } = liveness(host, agents, now);
  return (
    <div className="flex items-center gap-3 px-3 py-3">
      <SetupMark src={ICON.machine} size={42} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold">{host.host}</p>
        <p className="truncate text-[13px] text-muted-foreground">
          {host.agents === 0
            ? "No agents yet"
            : `${String(host.agents)} agent${host.agents === 1 ? "" : "s"}`}
          {host.reef ? ` · reef ${host.reef}` : ""}
        </p>
      </div>
      <span
        title={detail}
        className="flex shrink-0 items-center gap-1.5 text-[13px] text-muted-foreground"
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            live ? "bg-emerald-500" : "border border-muted-foreground/40",
          )}
        />
        {live ? "Live" : "Quiet"}
      </span>
    </div>
  );
}

/** The page's one empty state, in the wizard's language: a mark, a line, and
 *  the single door out. */
function Panel({
  title,
  line,
  action,
}: {
  title: string;
  line: string;
  action?: { label: string; run: () => void };
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/70 px-6 py-10 text-center">
      <SetupMark src={ICON.host} size={56} />
      <div className="space-y-1">
        <p className="text-[15px] font-medium">{title}</p>
        <p className="text-[13px] text-balance text-muted-foreground">{line}</p>
      </div>
      {action && (
        <Button size="sm" onClick={action.run}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
