import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getReef } from "@/lib/api";
import { parseAgentImage } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";
import { ReefState, SettingsRow, SettingsSection } from "@/components/settings/Settings";
import { Button } from "@/components/ui/button";

const dotted = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" · ");

export function MachineSection({ orgId, host, name }: { orgId: string; host: string; name: string }) {
  const { data: reef } = useQuery({
    queryKey: queryKeys.reef(orgId),
    queryFn: () => getReef(orgId),
  });

  const hostRow = reef?.hosts.find((h) => h.host === host);
  const agent = hostRow?.agents.find((a) => a.name === name);

  return (
    <SettingsSection label="Machine">
      <SettingsRow
        title="Host"
        description={dotted(
          host,
          hostRow && hostRow.health !== "live" && `host ${hostRow.health}`,
          agent?.vm && agent.vm !== agent.state && `vm ${agent.vm}`,
          agent ? !agent.synced && "syncing" : reef && "no report yet",
        )}
        control={agent && <ReefState state={agent.state} />}
      />
      <SettingsRow
        title="Role"
        description={
          agent && dotted(agent.role, parseAgentImage(agent.image).label, !agent.role_current && "update pending")
        }
        control={
          <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/settings/reef" />}>
            Reef
          </Button>
        }
      />
    </SettingsSection>
  );
}
