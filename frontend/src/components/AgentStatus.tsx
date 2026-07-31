import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { UserAvatar } from "@/components/UserAvatar";
import { PresenceDot } from "@/components/PresenceDot";
import { useAgentStatus } from "@/hooks/useAgentPresence";
import { agentStatusLabel } from "@/lib/agentLiveness";
import type { AgentOperator } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Agent avatar with a live availability dot (bottom-right) and an optional
 * operator-avatar badge (top-right). Shared by the agents list, the home-page
 * agent cards, and the agent profile hero so the treatment stays identical.
 *
 * The dot derives from the presence provider (``useAgentStatus``), so it ticks
 * ``available -> offline`` on its own once the heartbeat ages past the window.
 * Seed the provider from whatever payload carries ``last_alive_at`` at the call
 * site (the list/profile queries do this) so the dot is populated.
 */
export function AgentAvatarWithPresence({
  agentId,
  name,
  src,
  size,
  operator,
  ringClassName = "ring-card",
  className,
}: {
  agentId: string;
  /** Seed for the initial-letter fallback. */
  name: string;
  /** Agent avatar URL (typically ``agent.avatar?.url``). */
  src?: string | null;
  /** Agent avatar diameter in px. The dot and operator badge scale from this. */
  size: number;
  /** When set, render the operator's avatar as a small badge in the top-right. */
  operator?: AgentOperator | null;
  /** Ring color matching the surface behind the avatar so the dot/badge read
   *  as cut-outs. Default ``ring-card``; pass ``ring-background`` on bare pages. */
  ringClassName?: string;
  className?: string;
}) {
  const status = useAgentStatus(agentId);
  const dotSize = Math.max(8, Math.round(size * 0.27));
  const operatorSize = Math.max(12, Math.round(size * 0.4));
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <AgentFaceAvatar size={size} name={name} src={src} />
      {operator && (
        <span
          className={cn("absolute -right-1.5 -top-1.5 inline-flex rounded-lg ring-2", ringClassName)}
          title={operator.display_name ? `Operated by ${operator.display_name}` : "Operator"}
        >
          <UserAvatar
            size={operatorSize}
            name={operator.display_name ?? String(operator.human_id)}
            src={operator.avatar?.url}
          />
        </span>
      )}
      <span className="pointer-events-none absolute -bottom-0.5 -right-0.5">
        <PresenceDot
          status={status}
          size={dotSize}
          ringClassName={ringClassName}
          label={agentStatusLabel(status)}
        />
      </span>
    </span>
  );
}

