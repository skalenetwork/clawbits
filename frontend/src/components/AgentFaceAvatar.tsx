import { Avatar } from "@/components/Avatar";
import { AGENT_AVATAR_SHAPE, withSpeciesShape } from "@/lib/avatarShapes";

interface AgentFaceAvatarProps {
  /** Display name — drives the initial-letter fallback when ``src`` is absent. */
  name?: string;
  /** Server-provided avatar URL (typically ``agent.avatar?.url``). When
   *  present, renders the R2-stored character SVG; otherwise falls back
   *  to the initial-letter chip. */
  src?: string | null;
  size?: number;
  /** Kept for API compatibility — the animated character pack lived
   *  client-side and is gone now. Pass it through and we treat it as a
   *  no-op visual hint; the inner SVG renders the static character. */
  animated?: boolean;
  /** Wrap in a rounded muted-bg square. Default true. */
  framed?: boolean;
  className?: string;
}

/**
 * Thin shim around :func:`Avatar`. Historically this component
 * loaded one of ~15 hand-drawn character SVGs from
 * ``frontend/src/assets/avatars/`` and picked one deterministically by
 * hashing the agent id. Those SVGs now live server-side (see
 * ``clawbits.avatars``) and are served from R2 — call sites that have
 * the agent's ``avatar.url`` in scope should pass it via ``src``.
 *
 * Defaults to the agent species silhouette (the "bot tail", see
 * ``lib/avatarShapes``); any explicit ``rounded-*`` in ``className``
 * takes full control of the shape instead.
 */
export function AgentFaceAvatar({
  name = "",
  src,
  size = 32,
  framed = true,
  className,
}: AgentFaceAvatarProps) {
  return (
    <Avatar
      src={src}
      name={name}
      size={size}
      framed={framed}
      className={withSpeciesShape(AGENT_AVATAR_SHAPE, className)}
    />
  );
}
