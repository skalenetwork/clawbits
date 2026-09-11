/** The machines pulling from the org's repository and the agents declared on
 *  them. Nothing here reaches a host: every verdict is read from what they push. */
import { useState, type ComponentProps } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { RefreshCw, Sparkles, Trash2, TriangleAlert, type LucideIcon } from "lucide-react";
import {
  ArrowUpRight01Icon as ArrowUpRight,
  Delete02Icon as Trash,
  MoreHorizontalIcon as More,
} from "@hugeicons/core-free-icons";
import { ReefIcon } from "@/components/ReefIcon";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import {
  ReefHealth,
  SettingsPage,
  SettingsRow,
  SettingsRowSkeleton,
  SettingsSection,
  SettingsStatus,
} from "@/components/settings/Settings";
import { SetupMark } from "@/components/setup/SetupShell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/context/AuthContext";
import { useActiveOrg } from "@/hooks/useActiveOrg";
import { deleteReef, deleteReefAgent, getReef } from "@/lib/api";
import { confirm } from "@/lib/confirm";
import { formatRelativeAgo, formatRelativeShort, parseUtcTimestamp } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";

interface Status {
  tone: ComponentProps<typeof SettingsStatus>["tone"];
  label: string;
}

const MARK = { machine: "/computer.webp", agent: "/openclaw.png", repo: "/github.webp" };

const STATE: Partial<Record<string, Status>> = {
  running: { tone: "ok", label: "Running" },
  pending: { tone: "idle", label: "Starting" },
  stopped: { tone: "idle", label: "Stopped" },
  failed: { tone: "bad", label: "Failed" },
};

const EVENT_KIND: Partial<Record<string, { icon: LucideIcon; tone: string }>> = {
  created: { icon: Sparkles, tone: "bg-emerald-500/12 text-emerald-500" },
  updated: { icon: RefreshCw, tone: "bg-sky-500/12 text-sky-500" },
  deleted: { icon: Trash2, tone: "bg-destructive/12 text-destructive" },
  failed: { icon: TriangleAlert, tone: "bg-destructive/12 text-destructive" },
};
const EVENTS_PREVIEW = 8;
const EVENT_ROW =
  "relative flex min-h-13 items-center gap-3 px-4 py-3 text-[13px] not-first:before:absolute not-first:before:inset-x-4 not-first:before:top-0 not-first:before:h-px not-first:before:bg-foreground/8";

const RELATIVE = new Intl.RelativeTimeFormat("en", { style: "narrow" });

function expiresIn(at: string): string {
  const min = Math.max(1, Math.round((parseUtcTimestamp(at).getTime() - Date.now()) / 60_000));
  if (min < 60) return `Expires ${RELATIVE.format(min, "minute")}`;
  if (min < 1440) return `Expires ${RELATIVE.format(Math.floor(min / 60), "hour")}`;
  return `Expires ${RELATIVE.format(Math.floor(min / 1440), "day")}`;
}

const muted = (text: string) => <span className="font-normal text-muted-foreground">{text}</span>;

export default function SettingsReefPage() {
  const { activeOrgId } = useAuth();
  const orgId = activeOrgId ?? "";
  const { isOwner } = useActiveOrg();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [allEvents, setAllEvents] = useState(false);

  const reefQuery = useQuery({
    queryKey: queryKeys.reef(orgId),
    queryFn: () => getReef(orgId),
    enabled: Boolean(activeOrgId),
    refetchInterval: 30_000,
  });
  const reef = reefQuery.data;

  const disconnect = useMutation({
    mutationFn: () => deleteReef(orgId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reef(orgId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.orgs });
      toast.success("Repository disconnected");
    },
    onError: (e) => {
      toast.error(errMsg(e, "Couldn't disconnect the repository"));
    },
  });

  const remove = useMutation({
    mutationFn: ({ host, name }: { host: string; name: string }) => deleteReefAgent(orgId, host, name),
    onSuccess: (_, { name }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reef(orgId) });
      toast.success(`${name} removed`);
    },
    onError: (e) => {
      toast.error(errMsg(e, "Couldn't remove the agent"));
    },
  });

  if (!activeOrgId) {
    return <div className="text-sm text-muted-foreground">Select an organization.</div>;
  }

  const go = (to: string) => () => {
    void navigate(to);
  };
  const hosts = reef?.hosts ?? [];
  const enrolled = new Set(hosts.flatMap((h) => h.agents.map((a) => `${h.host}/${a.name}`)));
  const waiting = (reef?.declared ?? []).filter((d) => !enrolled.has(`${d.host}/${d.name}`));
  const events = hosts
    .flatMap((h) =>
      h.events.flatMap((e) => {
        const look = EVENT_KIND[e.kind];
        return look ? [{ ...e, host: h.host, look }] : [];
      }),
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const shownEvents = allEvents ? events : events.slice(0, EVENTS_PREVIEW);

  const agentMenu = (host: string, name: string) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${name}`}
        disabled={remove.isPending}
        render={<Button variant="ghost" size="icon-sm" />}
      >
        <Icon icon={More} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          variant="destructive"
          onClick={() => {
            void confirm({
              title: `Remove ${name}?`,
              description: `${host} drops it on its next pull. Its data is kept, so declaring the same name again brings it back.`,
              confirmLabel: "Remove",
              destructive: true,
            }).then((ok) => {
              if (ok) remove.mutate({ host, name });
            });
          }}
        >
          <Icon icon={Trash} /> Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const repoMark = <SetupMark src={MARK.repo} size={32} />;

  return (
    <SettingsPage>
      <PageHeader
        leading={<ReefIcon className="size-4 shrink-0 text-muted-foreground" />}
        title="Reef"
        actions={
          reef?.connected ? (
            <>
              {isOwner && (
                <Button variant="secondary" size="sm" onClick={go("/setup/reef")}>
                  Add machine
                </Button>
              )}
              <Button size="sm" onClick={go("/setup/agent")}>
                New agent
              </Button>
            </>
          ) : null
        }
      />

      {reefQuery.isLoading ? (
        <SettingsSection label="Machines">
          {[0, 1].map((i) => (
            <SettingsRowSkeleton key={i} />
          ))}
        </SettingsSection>
      ) : reefQuery.isError ? (
        <SettingsSection>
          <SettingsRow
            title="Couldn't load Reef"
            error={errMsg(reefQuery.error, "Try again in a moment")}
          />
        </SettingsSection>
      ) : (
        <>
          {reef?.connected && (
            <>
              <SettingsSection label="Machines">
                {hosts.length === 0 ? (
                  <SettingsRow
                    title="No machine has reported yet"
                    control={
                      isOwner ? (
                        <Button variant="outline" size="sm" onClick={go("/setup/reef")}>
                          Add machine
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  hosts.map((h) => (
                    <SettingsRow
                      key={h.host}
                      leading={<SetupMark src={MARK.machine} size={32} />}
                      title={h.host}
                      description={[
                        `${h.agents.length} agent${h.agents.length === 1 ? "" : "s"}`,
                        h.reef && `reef ${h.reef}`,
                        h.last_seen ? `heartbeat ${formatRelativeAgo(h.last_seen)}` : "no heartbeat yet",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      error={h.error}
                      control={<ReefHealth health={h.health} />}
                    />
                  ))
                )}
              </SettingsSection>

              <SettingsSection label="Agents">
                {enrolled.size + waiting.length === 0 && <SettingsRow title={muted("No agents yet")} />}
                {hosts.flatMap((h) =>
                  h.agents.map((a) => {
                    const state: Status = STATE[a.state] ?? { tone: "idle", label: a.state };
                    return (
                      <SettingsRow
                        key={`${h.host}/${a.name}`}
                        leading={<SetupMark src={MARK.agent} size={32} />}
                        title={a.name}
                        description={`${a.role} on ${h.host}${a.role_current ? "" : " · role update pending"}${a.synced ? "" : " · syncing"}`}
                        error={
                          a.state === "failed"
                            ? h.events.find((e) => e.agent === a.name && e.kind === "failed")?.detail
                            : undefined
                        }
                        control={
                          <>
                            <SettingsStatus tone={state.tone}>{state.label}</SettingsStatus>
                            {isOwner && agentMenu(h.host, a.name)}
                          </>
                        }
                      />
                    );
                  }),
                )}
                {waiting.map((d) => (
                  <SettingsRow
                    key={`${d.host}/${d.name}`}
                    leading={<SetupMark src={MARK.agent} size={32} />}
                    title={d.name}
                    description={`Waiting to join ${d.host}`}
                    control={
                      <>
                        <SettingsStatus tone="idle">{expiresIn(d.expires_at)}</SettingsStatus>
                        {isOwner && agentMenu(d.host, d.name)}
                      </>
                    }
                  />
                ))}
              </SettingsSection>

              <SettingsSection label="Activity">
                {events.length === 0 ? (
                  <SettingsRow title={muted("Nothing has happened yet")} />
                ) : (
                  <ol>
                    {shownEvents.map((e) => (
                      <li key={`${e.host}/${e.at}/${e.agent}/${e.kind}`} className={EVENT_ROW}>
                        <span className={cn("grid size-5 shrink-0 place-items-center rounded-md", e.look.tone)}>
                          <e.look.icon className="size-3" />
                        </span>
                        <span className="min-w-0 basis-1/2 wrap-anywhere">
                          <span className="font-medium">{e.agent}</span>{" "}
                          {e.kind === "failed" ? (
                            <span className="text-destructive">
                              failed{e.detail && `: ${e.detail}`}
                            </span>
                          ) : (
                            e.kind
                          )}
                        </span>
                        <span className="flex-1 text-muted-foreground tabular-nums">
                          {formatRelativeShort(e.at)}
                        </span>
                        <span className="w-20 shrink-0 truncate text-right text-muted-foreground">{e.host}</span>
                      </li>
                    ))}
                  </ol>
                )}
                {shownEvents.length < events.length && (
                  <div className={EVENT_ROW}>
                    <span className="w-5 shrink-0" />
                    <button
                      type="button"
                      className="font-medium text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setAllEvents(true);
                      }}
                    >
                      Show all
                    </button>
                  </div>
                )}
              </SettingsSection>
            </>
          )}

          <SettingsSection label="Repository">
            {reef?.repo ? (
              <>
                <SettingsRow
                  leading={repoMark}
                  title={<span className="wrap-anywhere">{reef.repo}</span>}
                  description="Machines sync every 30 seconds"
                  control={
                    <Button
                      variant="outline"
                      size="sm"
                      nativeButton={false}
                      render={<a href={`https://github.com/${reef.repo}`} target="_blank" rel="noreferrer" />}
                    >
                      Open
                      <Icon icon={ArrowUpRight} />
                    </Button>
                  }
                />
                <SettingsRow
                  title="Token"
                  description={reef.connected ? "Stored and readable" : "The stored token can't be read"}
                  control={
                    isOwner ? (
                      <Button variant="outline" size="sm" onClick={go("/setup/reef?replace=1")}>
                        Replace token
                      </Button>
                    ) : undefined
                  }
                />
                {isOwner && (
                  <SettingsRow
                    title="Disconnect"
                    description="Agents keep running; Clawbits stops reading the repo"
                    control={
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
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
                    }
                  />
                )}
              </>
            ) : (
              <SettingsRow
                leading={repoMark}
                title="No repository connected"
                description={isOwner ? undefined : "An admin can connect one"}
                control={
                  isOwner ? (
                    <Button size="sm" onClick={go("/setup/reef")}>
                      Connect
                    </Button>
                  ) : undefined
                }
              />
            )}
          </SettingsSection>
        </>
      )}
    </SettingsPage>
  );
}
