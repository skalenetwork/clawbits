import { cn } from "@/lib/utils";
import type { AgentLivenessStatus, GlobalUserStatus } from "@/lib/api";

/** Union of every status the dot can render — human global presence plus
 *  agent global liveness. "online"/"available" share the green treatment;
 *  "offline" (either kind) shares gray. */
type DotStatus = GlobalUserStatus | AgentLivenessStatus;

interface PresenceDotProps {
  status: DotStatus;
  /** Pixel diameter of the dot. Defaults to a tasteful 10 — about a third
   *  of a 32px avatar.  */
  size?: number;
  /** Render the parent avatar's background color around the dot so it
   *  reads as a visual cut-out. Defaults to the sidebar background. */
  ringClassName?: string;
  className?: string;
  /** Friendly hover/aria text. Defaults to the raw status string — pass a
   *  nicer label (e.g. "Available", "Setting up…") for agents. */
  label?: string;
}

/**
 * Small status indicator overlay for user and agent avatars.
 *
 * Position it as an absolutely-positioned child of a ``relative``
 * wrapper around the avatar — see ``UserAvatar`` / ``AgentFaceAvatar``
 * usage in DM rows and member lists.
 *
 * Offline renders as a muted gray dot rather than hiding; this gives a
 * consistent affordance and makes "we know they're offline"
 * distinguishable from "we have no presence info yet". "setup" (an agent
 * onboarding, not yet pinged) pulses to read as "connecting…".
 */
export function PresenceDot({
  status,
  size = 10,
  ringClassName,
  className,
  label,
}: PresenceDotProps) {
  const color =
    status === "online" || status === "available"
      ? "bg-emerald-500"
      : status === "idle"
        ? "bg-amber-400"
        : status === "setup"
          ? "bg-blue-500"
          : "bg-zinc-400 dark:bg-zinc-600";
  const text = label ?? status;
  return (
    <span
      aria-label={`Status: ${text}`}
      title={text}
      className={cn(
        "block rounded-full ring-2",
        color,
        status === "setup" && "animate-pulse",
        ringClassName ?? "ring-background",
        className,
      )}
      style={{ width: size, height: size }}
    />
  );
}
