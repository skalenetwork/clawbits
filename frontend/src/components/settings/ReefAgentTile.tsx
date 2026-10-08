import type { ReactNode } from "react";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { Squircle } from "@/components/home/tiles";
import { SettingsTile, StatusDot } from "@/components/settings/Settings";
import type { StatusTone } from "@/lib/status";
import { useAgentStatus } from "@/hooks/useAgentPresence";
import { agentDisplay } from "@/lib/agentDisplay";
import type { AgentLivenessStatus, AgentUser, ReefHostAgent } from "@/lib/api";
import { RUNTIME_LOGO, formatAgentVersion, parseAgentImage, reefAttention } from "@/lib/formatting";

export interface ReefAgentTileProps {
  host: string;
  name: string;
  row?: ReefHostAgent;
  agent?: AgentUser;
  failure?: string;
  expires?: string;
  menu?: ReactNode;
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
  const title = agent ? agentDisplay(agent) : name;

  return (
    <SettingsTile
      leading={
        <Squircle size={40}>
          <AgentFaceAvatar src={agent?.avatar?.url} name={title} size={40} className="rounded-none" />
        </Squircle>
      }
      title={title}
      href={agent ? `/agents/${encodeURIComponent(agent.agent_id)}` : undefined}
      subtitle={
        <span className="flex items-center gap-1.5" title={row?.image}>
          {logo && <img src={logo} alt="" className="size-3.5 shrink-0" />}
          <span className="truncate">{image ? formatAgentVersion(image, agent?.plugin_version) : joining}</span>
        </span>
      }
      aside={agent?.is_operator ? null : agent?.operator?.display_name}
      pill={expires == null ? row && reefAttention(row) : { label: expires }}
      end={
        <>
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
        </>
      }
    />
  );
}
