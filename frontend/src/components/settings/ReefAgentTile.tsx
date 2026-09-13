import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { Squircle } from "@/components/home/tiles";
import { StatusDot, type StatusTone } from "@/components/settings/Settings";
import { useAgentStatus } from "@/hooks/useAgentPresence";
import { agentDisplay } from "@/lib/agentDisplay";
import type { AgentLivenessStatus, AgentUser, ReefHostAgent } from "@/lib/api";
import { formatAgentVersion, parseAgentImage } from "@/lib/formatting";
import { cn } from "@/lib/utils";

const RUNTIME_LOGO: Record<string, string> = {
  openclaw: "/openclaw.png",
  hermes: "/hermes.png",
  ironclaw: "/ironclaw.png",
};

export interface ReefAgentTileProps {
  host: string;
  name: string;
  row?: ReefHostAgent;
  agent?: AgentUser;
  failure?: string;
  expires?: string;
  menu?: ReactNode;
}

function attention(row: ReefHostAgent): { bad?: boolean; label: string } | null {
  if (row.state === "failed") return { bad: true, label: "failed" };
  if (!row.role_current) return { label: "update pending" };
  if (!row.synced) return { label: "syncing" };
  if (row.state === "running") return null;
  return { label: row.state === "pending" ? "starting" : row.state };
}

function machineStatus(
  row: ReefHostAgent,
  live: AgentLivenessStatus | null,
  failure: string | undefined,
): { tone: StatusTone; label: string } {
  if (row.state === "failed") return { tone: "bad", label: failure ?? "Failed" };
  if (row.state === "stopped") return { tone: "idle", label: "Stopped" };
  if (row.state !== "running") return { tone: "idle", label: "Starting" };
  if (live == null || live === "setup") return { tone: "warn", label: "Starting up" };
  if (live === "offline") return { tone: "warn", label: "Running, agent not responding" };
  return { tone: "ok", label: "Running" };
}

export function ReefAgentTile({ host, name, row, agent, failure, expires, menu }: ReefAgentTileProps) {
  const live = useAgentStatus(agent?.agent_id, agent?.last_alive_at);
  const joining = `Waiting to join ${host}`;
  // With no agent id the hook reports "offline", which would read as a machine fault.
  const { tone, label } = row
    ? machineStatus(row, agent ? live : null, failure)
    : ({ tone: "idle", label: joining } as const);
  const image = row ? parseAgentImage(row.image) : null;
  const logo = RUNTIME_LOGO[agent?.agent_type ?? image?.scheme?.runtime ?? ""];
  const owner = agent?.is_operator ? null : agent?.operator?.display_name;
  const chip = expires == null ? (row ? attention(row) : null) : { label: expires };
  const title = agent ? agentDisplay(agent) : name;

  return (
    <div className="group relative grid min-h-16 grid-cols-[40px_minmax(6rem,1fr)_minmax(0,auto)_auto] items-center gap-x-[11px] rounded-[14px] bg-card p-3 has-[a:hover]:bg-foreground/4 has-[a:focus-visible]:bg-foreground/4">
      <Squircle size={40}>
        <AgentFaceAvatar src={agent?.avatar?.url} name={title} size={40} className="rounded-none" />
      </Squircle>

      <span className="min-w-0">
        {agent ? (
          <Link
            to={`/agents/${encodeURIComponent(agent.agent_id)}`}
            className="block truncate text-sm font-medium outline-none after:absolute after:inset-0"
          >
            {title}
          </Link>
        ) : (
          <span className="block truncate text-sm font-medium">{title}</span>
        )}
        <span
          className="flex items-center gap-1.5 text-[13px] text-muted-foreground tabular-nums"
          title={row?.image}
        >
          {logo && <img src={logo} alt="" className="size-3.5 shrink-0" />}
          <span className="truncate">
            {image ? formatAgentVersion(image, agent?.plugin_version) : joining}
          </span>
        </span>
      </span>

      <span className="flex min-w-0 flex-col items-end gap-1">
        {owner && (
          <span className="max-w-full truncate text-[13px] text-muted-foreground">{owner}</span>
        )}
        {chip && (
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[12px] whitespace-nowrap",
              chip.bad ? "bg-destructive/10 text-destructive" : "bg-foreground/6 text-muted-foreground",
            )}
          >
            {chip.label}
          </span>
        )}
      </span>

      <span className="relative flex w-7 items-center justify-center gap-1.5 pointer-coarse:w-auto">
        <StatusDot
          tone={tone}
          label={label}
          className={
            menu == null
              ? undefined
              : "group-hover:hidden group-focus-within:hidden group-has-[[aria-expanded=true]]:hidden"
          }
        />
        {menu}
      </span>
    </div>
  );
}
