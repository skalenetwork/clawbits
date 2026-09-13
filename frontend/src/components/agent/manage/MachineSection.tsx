import { useQuery } from "@tanstack/react-query";
import { ComputerIcon, CubeIcon } from "@hugeicons/core-free-icons";
import { Server } from "lucide-react";
import { Link } from "react-router-dom";
import { getReef, type AgentProfile } from "@/lib/api";
import { parseAgentImage } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";
import { SectionHeader } from "@/components/automations/SectionHeader";
import { ReefHealth, ReefState } from "@/components/settings/Settings";
import { Button } from "@/components/ui/button";
import { ManageTile } from "./ManageTile";

const line = (...parts: (string | false | null | undefined)[]) => (
  <span className="block truncate">{parts.filter(Boolean).join(" · ")}</span>
);

export function MachineSection({ orgId, profile }: { orgId: string; profile: AgentProfile }) {
  const host = profile.reef_host ?? "";
  const name = profile.reef_name ?? "";

  const { data: reef } = useQuery({
    queryKey: queryKeys.reef(orgId),
    queryFn: () => getReef(orgId),
    enabled: Boolean(orgId && host && name),
  });

  if (!host || !name) return null;

  const hostRow = reef?.hosts.find((h) => h.host === host);
  const agent = hostRow?.agents.find((a) => a.name === name);

  return (
    <section className="space-y-3">
      <SectionHeader icon={Server}>Machine</SectionHeader>
      <div className="grid gap-3 sm:grid-cols-2">
        <ManageTile
          icon={ComputerIcon}
          title="Host"
          caption={line(
            host,
            agent?.vm && agent.vm !== agent.state && `vm ${agent.vm}`,
            agent ? !agent.synced && "syncing" : reef && "no report yet",
          )}
          control={
            <div className="flex items-center gap-2.5">
              {agent && <ReefState state={agent.state} />}
              {hostRow && <ReefHealth health={hostRow.health} />}
            </div>
          }
        />

        <ManageTile
          icon={CubeIcon}
          title="Role"
          caption={
            agent &&
            line(agent.role, parseAgentImage(agent.image).label, !agent.role_current && "update pending")
          }
          control={
            <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/settings/reef" />}>
              Reef
            </Button>
          }
        />
      </div>
    </section>
  );
}
