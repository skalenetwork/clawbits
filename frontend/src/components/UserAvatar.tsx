import { Avatar } from "@/components/Avatar";
import { HUMAN_AVATAR_SHAPE, withSpeciesShape } from "@/lib/avatarShapes";

interface UserAvatarProps {
  /** Stable display name — drives the initial-letter fallback. */
  name: string;
  /** Server-provided avatar URL. When present, renders the SVG fetched
   *  from R2; otherwise falls back to the initial-letter chip. */
  src?: string | null;
  size?: number;
  className?: string;
}

/**
 * Thin compatibility shim around :func:`Avatar`. Pass ``src`` (from the
 * server's ``avatar.url`` field) when the call site has the entity in
 * scope; older sites that only have a name keep working with the
 * initial-letter fallback until they're updated.
 *
 * Defaults to the human species silhouette (fully soft, see
 * ``lib/avatarShapes``); any explicit ``rounded-*`` in ``className``
 * takes full control of the shape instead.
 */
export function UserAvatar({ name, src, size = 32, className }: UserAvatarProps) {
  return <Avatar src={src} name={name} size={size} className={withSpeciesShape(HUMAN_AVATAR_SHAPE, className)} />;
}
