/** New agent, full screen: where it runs, what runs, then the machine (Reef) or
 *  the prompt to paste (self-hosted). Each screen is one View that the render
 *  and the keyboard both read. The agent's id and nickname are minted up front,
 *  so each waiting screen watches for exactly that agent. */
import { useAgentStatus } from "@/hooks/useAgentPresence";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ReefHealth } from "@/components/settings/Settings";
import {
  Checks,
  CommandBlock,
  CopyField,
  SetupButton,
  SetupMark,
  SetupPanel,
  SetupShell,
  type SetupStep,
} from "@/components/setup/SetupShell";
import { useAuth } from "@/context/AuthContext";
import { useActiveOrg } from "@/hooks/useActiveOrg";
import {
  buildHermesSetupPrompt,
  buildIronClawSetupPrompt,
  buildOpenClawSetupPrompt,
} from "@/lib/agentPrompts";
import {
  createMmChannelPost,
  createOrGetMmDirect,
  createReefAgent,
  deleteReefAgent,
  getAgents,
  getReef,
  listReefRoles,
  startHumanAgentSignup,
  type ReefCreatedAgent,
  type ReefHost,
  type ReefRole,
} from "@/lib/api";
import { formatRelativeAgo } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const ICON = {
  reef: "/reef-dark.webp",
  computer: "/computer.webp",
  waiting: "/waiting.webp",
  reporting: "/reporting.webp",
};

const RUNTIMES = {
  openclaw: {
    title: "OpenClaw",
    icon: "/openclaw.png",
    meta: "The default, with the Clawbits plugin",
    prompt: buildOpenClawSetupPrompt,
  },
  hermes: {
    title: "Hermes",
    icon: "/hermes.png",
    meta: "NousResearch agent harness",
    prompt: buildHermesSetupPrompt,
  },
  ironclaw: {
    title: "IronClaw",
    icon: "/ironclaw.png",
    meta: "Rust agent runtime",
    prompt: buildIronClawSetupPrompt,
  },
};

type Runtime = keyof typeof RUNTIMES;

/** What has been answered. The screen is derived from it, so going back is
 *  dropping the last answer. */
type Answers =
  | { where: null }
  | { where: "reef"; role?: string; host?: string }
  | { where: "self"; runtime?: Runtime };

interface Choice {
  icon: string;
  title: string;
  meta: string;
  /** Absent: shown, but not pressable and without a key. */
  pick?: () => void;
  soon?: boolean;
  health?: ReefHost["health"];
}

interface Action {
  label: string;
  run: () => void;
  busy?: boolean;
}

interface View {
  screen: string;
  /** Stepper position; 3 once every step is answered. */
  at: number;
  icon?: ReactNode;
  title: string;
  line?: string;
  choices?: Choice[];
  body?: ReactNode;
  back?: () => void;
  alt?: Action;
  primary?: Action;
}

/** Reef images are OpenClaw today; the other runtimes are listed as coming. */
const SOON: Choice[] = (["hermes", "ironclaw"] as const).map((r) => ({ ...RUNTIMES[r], soon: true }));

/** Roles have no title yet, so the name and what it is given tell them apart. */
function roleMeta({ name, resources }: ReefRole): string {
  const cpu = resources.vcpus;
  const mib = resources["memory-mib"];
  const parts = [name];
  if (cpu) parts.push(`${cpu} CPU`);
  if (mib) parts.push(mib >= 1024 ? `${Math.round(mib / 102.4) / 10} GB` : `${mib} MB`);
  return parts.join(" · ");
}

export default function AgentSetupPage() {
  const { activeOrgId } = useAuth();
  const orgId = activeOrgId ?? "";
  const { org, isOwner, isLoading } = useActiveOrg();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [a, setAnswers] = useState<Answers>({ where: null });
  const [copied, setCopied] = useState(false);
  const [showIds, setShowIds] = useState(false);

  const exit = () => {
    // react-router numbers its history entries: above 0 there is a page in
    // this app to return to, at 0 the tab opened straight onto the wizard.
    if (((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0) void navigate(-1);
    else void navigate("/agents");
  };

  const create = useMutation({
    mutationFn: (body: { host: string; role: string }) => createReefAgent(orgId, body),
    onError: (e, body) => {
      toast.error(errMsg(e, "Couldn't create the agent"));
      setAnswers(hosts.length > 1 ? { where: "reef", role: body.role } : { where: "reef" });
    },
  });

  const remove = useMutation({
    mutationFn: (agent: ReefCreatedAgent) => deleteReefAgent(orgId, agent.host, agent.name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reef(orgId) });
    },
    onError: (e) => {
      toast.error(errMsg(e, "Couldn't remove the agent"));
    },
  });

  const mint = useMutation({
    mutationFn: () => startHumanAgentSignup(orgId),
    onError: (e) => {
      toast.error(errMsg(e, "Couldn't start the signup"));
      setAnswers({ where: "self" });
    },
  });

  const sayHi = useMutation({
    mutationFn: async (agentId: string) => {
      const channel = await createOrGetMmDirect(orgId, "agent", agentId);
      await createMmChannelPost(channel.channel_id, "Hi! 👋");
      return channel;
    },
    onSuccess: (channel) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
      void navigate(`/channels/${channel.channel_id}`, { replace: true });
    },
    onError: (e) => {
      toast.error(errMsg(e, "Couldn't open the chat"));
    },
  });

  const created = create.data;
  const minted = a.where === "reef" ? created : a.where === "self" ? mint.data : undefined;

  const reef = useQuery({
    queryKey: queryKeys.reef(orgId),
    queryFn: () => getReef(orgId),
    enabled: Boolean(activeOrgId),
    refetchInterval: (q) => {
      if (!created) return false;
      const row = q.state.data?.hosts
        .find((h) => h.host === created.host)?.agents
        .find((x) => x.name === created.name);
      return row?.state === "running" ? false : 4_000;
    },
  });
  const roles = useQuery({
    queryKey: queryKeys.reefRoles(orgId),
    queryFn: () => listReefRoles(orgId),
    enabled: a.where === "reef",
  });
  const agents = useQuery({
    queryKey: queryKeys.agents(orgId),
    queryFn: () => getAgents(orgId),
    enabled: Boolean(minted),
    refetchInterval: (q) => {
      if (!minted) return false;
      const found = q.state.data?.agents.find((x) => x.agent_id === minted.agent_id);
      if (!found) return 3_000;
      return a.where === "reef" && !found.last_alive_at ? 3_000 : false;
    },
  });

  const hosts = reef.data?.hosts ?? [];
  const status = created && hosts.find((h) => h.host === created.host);
  const onHost = created && status?.agents.find((x) => x.name === created.name);
  const agent = minted && agents.data?.agents.find((x) => x.agent_id === minted.agent_id);
  // The agent's own ping reaches us over SSE, ahead of the host's next status push.
  const live = useAgentStatus(minted ? minted.agent_id : null, agent ? agent.last_alive_at ?? null : undefined);
  const arrived = a.where === "reef" ? live === "available" || Boolean(agent?.last_alive_at) : Boolean(agent);
  // These land out of order: an agent can sign up and say hi before its host
  // reports, so every check implies the ones above it.
  const hasJoined = arrived || Boolean(agent);
  const isRunning = hasJoined || onHost?.state === "running";
  const pickedUp = isRunning || Boolean(onHost);
  const runtime: Runtime | undefined =
    a.where === "self" ? a.runtime : a.where === "reef" && a.role ? "openclaw" : undefined;

  function describe(): View {
    if (!a.where) {
      const ready = Boolean(reef.data?.connected) && hosts.length > 0;
      return {
        screen: "where",
        at: 0,
        title: "Where should your agent run?",
        choices: [
          {
            icon: ICON.reef,
            title: "On Reef",
            ...(reef.isPending
              ? { meta: "Checking your machines" }
              : ready
                ? {
                    meta: `Your machines: ${hosts.map((h) => h.host).join(", ")}`,
                    pick: () => {
                      setAnswers({ where: "reef" });
                    },
                  }
                : isOwner
                  ? {
                      meta: reef.data?.connected
                        ? "No machine has reported yet"
                        : "Not set up yet · takes a couple of minutes",
                      pick: () => {
                        void navigate("/setup/reef", { replace: true });
                      },
                    }
                  : { meta: "Ask an admin to set up Reef" }),
          },
          {
            icon: ICON.computer,
            title: "Self-hosted",
            meta: "Your own OpenClaw, Hermes or IronClaw",
            pick: () => {
              setAnswers({ where: "self" });
            },
          },
        ],
      };
    }

    if (minted && arrived && runtime) {
      return {
        screen: "arrival",
        at: 3,
        icon: <SetupMark src={ICON.reporting} size={84} />,
        title: `${minted.nickname} is ready`,
        line: created ? `Running on ${created.host}.` : "Connected and ready to talk.",
        body: (
          <div className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left">
            <img src={RUNTIMES[runtime].icon} alt="" className="size-[42px] shrink-0 rounded-xl" />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold">{minted.nickname}</span>
              <span className="block truncate text-[13px] text-muted-foreground">
                @{minted.agent_id} · {RUNTIMES[runtime].title}
                {created ? ` · ${created.host}` : ""}
              </span>
            </span>
          </div>
        ),
        primary: {
          label: "Say hi",
          run: () => {
            sayHi.mutate(minted.agent_id);
          },
          busy: sayHi.isPending,
        },
      };
    }

    if (a.where === "reef") {
      const { role, host } = a;
      if (!role) {
        return {
          screen: "role",
          at: 1,
          title: "Pick a role",
          line: roles.isPending
            ? `Reading roles from ${reef.data?.repo ?? "your Reef repo"}`
            : roles.isError
              ? errMsg(roles.error, "Couldn't read the roles")
              : roles.data.length === 0
                ? `No role in ${reef.data?.repo ?? "your Reef repo"} points its agents at this server.`
                : undefined,
          choices: roles.data && [
            ...roles.data.map((r) => ({
              ...RUNTIMES.openclaw,
              meta: roleMeta(r),
              pick: () => {
                const only = hosts.length === 1 ? hosts[0]!.host : undefined;
                setAnswers({ where: "reef", role: r.name, host: only });
                if (only) create.mutate({ host: only, role: r.name });
              },
            })),
            ...SOON,
          ],
          back: () => {
            setAnswers({ where: null });
          },
        };
      }
      if (!host) {
        return {
          screen: "machine",
          at: 2,
          title: "Which machine?",
          choices: hosts.map((h) => ({
            icon: ICON.computer,
            title: h.host,
            meta:
              `${h.agents.length} agent${h.agents.length === 1 ? "" : "s"}` +
              (h.last_seen ? ` · reported ${formatRelativeAgo(h.last_seen)}` : ""),
            health: h.health,
            pick: () => {
              setAnswers({ where: "reef", role, host: h.host });
              create.mutate({ host: h.host, role });
            },
          })),
          back: () => {
            setAnswers({ where: "reef" });
          },
        };
      }
      if (created && onHost?.state === "failed") {
        const reason = status?.events.find((e) => e.agent === created.name && e.kind === "failed");
        return {
          screen: "failed",
          at: 3,
          icon: (
            <span className="opacity-70 grayscale">
              <SetupMark src={ICON.waiting} size={84} />
            </span>
          ),
          title: `${created.nickname} couldn't start`,
          line: reason && `${host} reported this ${formatRelativeAgo(reason.at)}.`,
          body: (
            <pre className="w-full rounded-2xl border border-destructive/35 bg-destructive/7 px-3.5 py-3 font-mono text-[12.5px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
              {reason?.detail ?? "The machine did not say why."}
            </pre>
          ),
          alt: {
            label: "Remove",
            run: () => {
              remove.mutate(created, { onSuccess: exit });
            },
            busy: remove.isPending,
          },
          primary: {
            label: "Try again",
            run: () => {
              remove.mutate(created, {
                onSuccess: () => {
                  create.mutate({ host, role });
                },
              });
            },
            busy: remove.isPending,
          },
        };
      }
      return {
        screen: "starting",
        at: 3,
        icon: <SetupMark src={ICON.waiting} size={84} />,
        title: `Starting ${created?.nickname ?? "your agent"}`,
        line: `On ${host}. The first start takes a few minutes; you can leave.`,
        body: (
          <Checks
            items={[
              { label: "Declared", done: Boolean(created) },
              { label: `Picked up by ${host}`, done: pickedUp },
              { label: "Running", done: isRunning },
              { label: "Joined Clawbits", done: hasJoined },
              { label: "First ping", done: arrived },
            ]}
          />
        ),
      };
    }

    const picked = a.runtime;
    if (!picked) {
      return {
        screen: "runtime",
        at: 1,
        title: "Which runtime?",
        choices: (Object.keys(RUNTIMES) as Runtime[]).map((r) => ({
          ...RUNTIMES[r],
          pick: () => {
            setAnswers({ where: "self", runtime: r });
            if (!mint.data && !mint.isPending) mint.mutate();
          },
        })),
        back: () => {
          setAnswers({ where: null });
        },
      };
    }
    const session = mint.data;
    const prompt = session && RUNTIMES[picked].prompt(org, session.session_token);
    return {
      screen: "connect",
      at: 2,
      title: `Paste this into your ${RUNTIMES[picked].title}`,
      body: session && prompt && (
        <>
          <CommandBlock code={prompt} copy={false} />
          <div className="flex w-full flex-col">
            <button
              type="button"
              aria-expanded={showIds}
              onClick={() => { setShowIds((v) => !v); }}
              className="inline-flex items-center gap-1 self-start rounded-sm text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {showIds ? "Hide org ID and token" : "Or copy org ID and token manually"}
              <ChevronDown className={cn("size-3.5 transition-transform", showIds && "rotate-180")} />
            </button>
            <div
              inert={!showIds}
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                showIds ? "grid-rows-[1fr]" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <div className="-m-1 overflow-hidden p-1">
                <div className="grid w-full gap-2 pt-2 sm:grid-cols-2">
                  {org && <CopyField label="Org ID" value={org.org_id} onCopy={() => { setCopied(true); }} />}
                  <CopyField label="Signup token" value={session.session_token} onCopy={() => { setCopied(true); }} />
                </div>
              </div>
            </div>
          </div>
          <Checks items={[{ label: `Waiting for ${session.nickname}`, done: Boolean(agent) }]} />
        </>
      ),
      back: () => {
        setAnswers({ where: "self" });
      },
      primary: {
        label: "Copy prompt",
        run: () => {
          if (!prompt) return;
          void navigator.clipboard.writeText(prompt).then(() => {
            setCopied(true);
            toast.success("Prompt copied");
          });
        },
        busy: !prompt,
      },
    };
  }

  const [flashed, setFlashed] = useState<number | null>(null);
  const described = describe();
  const view: View = {
    ...described,
    choices: described.choices?.map(({ pick, ...c }, i) => ({
      ...c,
      pick:
        pick &&
        (() => {
          if (flashed !== null) return;
          setFlashed(i);
          setTimeout(() => {
            setFlashed(null);
            pick();
          }, 200);
        }),
    })),
  };

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing || e.repeat) return;
    // A focused control answers Enter natively; running the primary too
    // would press two things at once.
    const onControl =
      e.target instanceof Element && e.target.closest("button, a, input, textarea") !== null;
    const run =
      e.key === "Escape"
        ? view.back
        : e.key === "Enter"
          ? onControl || view.primary?.busy
            ? undefined
            : view.primary?.run
          : /^[1-9]$/.test(e.key)
            ? view.choices?.[Number(e.key) - 1]?.pick
            : undefined;
    if (!run) return;
    e.preventDefault();
    run();
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!activeOrgId || isLoading) return null;

  const steps: SetupStep[] = [
    a.where === "reef"
      ? { icon: ICON.reef, value: "Reef" }
      : { icon: ICON.computer, value: a.where && "Self-hosted" },
    { icon: runtime ? RUNTIMES[runtime].icon : "", value: runtime && RUNTIMES[runtime].title },
    a.where === "self"
      ? { icon: ICON.reporting, value: arrived ? "Connected" : null }
      : { icon: ICON.computer, value: a.where === "reef" ? a.host : null },
  ];

  return (
    <SetupShell
      steps={steps}
      at={view.at}
      onExit={exit}
      escExits={!view.back}
      unsaved={view.screen === "connect" && !copied ? "You haven't copied the prompt yet. This screen won't show it again." : null}
    >
      <SetupPanel key={view.screen} icon={view.icon} title={view.title} line={view.line}>
        {view.choices && (
          <div className="flex w-full flex-col gap-2">
            {view.choices.map((c, i) => (
              <ChoiceRow key={i} choice={c} digit={i + 1} picked={flashed === i} />
            ))}
          </div>
        )}
        {view.body}
        {(view.back ?? view.alt ?? view.primary) && (
          <div className="flex w-full gap-2">
            {view.back && (
              <SetupButton variant="ghost" chip="Esc" onClick={view.back}>
                Back
              </SetupButton>
            )}
            {view.alt && (
              <SetupButton variant="ghost" disabled={view.alt.busy} onClick={view.alt.run}>
                {view.alt.label}
              </SetupButton>
            )}
            {view.primary && (
              <SetupButton chip="Enter" disabled={view.primary.busy} onClick={view.primary.run}>
                {view.primary.label}
              </SetupButton>
            )}
          </div>
        )}
      </SetupPanel>
    </SetupShell>
  );
}

function ChoiceRow({ choice: c, digit, picked }: { choice: Choice; digit: number; picked: boolean }) {
  return (
    <button
      type="button"
      disabled={!c.pick}
      onClick={c.pick}
      data-picked={picked}
      className={cn(
        "flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-colors duration-200",
        "hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "data-[picked=true]:border-foreground data-[picked=true]:ring-1 data-[picked=true]:ring-foreground data-[picked=true]:transition-none",
        "disabled:pointer-events-none disabled:opacity-55",
      )}
    >
      <img src={c.icon} alt="" className="size-10 shrink-0 rounded-[10px]" />
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-semibold">{c.title}</span>
        <span className="block truncate text-[13px] text-muted-foreground">{c.meta}</span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
        {c.health && <ReefHealth health={c.health} />}
        {c.soon ? (
          <span className="rounded-full bg-foreground/6 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Soon
          </span>
        ) : (
          c.pick &&
          digit <= 9 && (
            <span
              aria-hidden="true"
              className="grid h-7 min-w-7 place-items-center rounded-[9px] border border-border bg-background px-2 text-[13px] font-medium text-muted-foreground"
            >
              {digit}
            </span>
          )
        )}
      </span>
    </button>
  );
}
