import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getReef, moveReefAgent } from "@/lib/api";
import { confirm } from "@/lib/confirm";
import { parseAgentImage } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";
import { toast } from "@/lib/toast";
import { ReefState, SettingsRow, SettingsSection } from "@/components/settings/Settings";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const dotted = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" · ");

export function MachineSection({
  orgId,
  agentId,
  host,
  name,
  canMove,
}: {
  orgId: string;
  agentId: string;
  host: string;
  name: string;
  canMove: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: reef } = useQuery({
    queryKey: queryKeys.reef(orgId),
    queryFn: () => getReef(orgId),
  });
  const move = useMutation({
    mutationFn: (to: string) => moveReefAgent(orgId, host, name, to),
    onSuccess: (_, to) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reef(orgId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentProfile(orgId, agentId) });
      toast.success(to === host ? `${name} redeclared on ${host}` : `${name} moving to ${to}`);
    },
  });
  const moveTo = (to: string) => {
    void confirm(
      to === host
        ? {
            title: `Redeclare ${name} on ${host}?`,
            description: `For a machine that was rebuilt: ${name} signs up again as itself, with its channel and history.`,
            confirmLabel: "Redeclare",
          }
        : {
            title: `Move ${name} to ${to}?`,
            description: `It comes back on ${to} as itself, with its channel and history. ${host} deletes its VM and data, and whatever lived only there is lost.`,
            confirmLabel: "Move",
          },
    ).then((ok) => {
      if (ok) move.mutate(to);
    });
  };

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
      {canMove && reef?.connected && (
        <SettingsRow
          title="Move"
          description="Brings it back on another machine as the same agent"
          control={
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={move.isPending}
                render={<Button variant="outline" size="sm" />}
              >
                Move
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {reef.hosts.map((h) => (
                  <DropdownMenuItem
                    key={h.host}
                    onClick={() => {
                      moveTo(h.host);
                    }}
                  >
                    {h.host === host ? `Redeclare on ${host}` : h.host}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
      )}
    </SettingsSection>
  );
}
