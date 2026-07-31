import { cn } from "@/lib/utils";

/**
 * Species avatar silhouettes — the shape tells the three species apart
 * before color or art does, everywhere an entity tile renders:
 *
 * - **Channels** are sharp tiles (structural — rooms, not beings).
 * - **Humans** are fully soft (≈ circular at list sizes).
 * - **Agents** are human-round with one machined bottom-left corner —
 *   the "bot tail". Bottom-left specifically: the bottom-right corner
 *   belongs to presence dots, so the two signals never collide.
 */
export const AGENT_AVATAR_SHAPE = "rounded-2xl rounded-bl-sm";
export const HUMAN_AVATAR_SHAPE = "rounded-2xl";
export const CHANNEL_AVATAR_SHAPE = "rounded-sm";

/**
 * Merge a species default with caller classes. Any explicit ``rounded-*``
 * token in ``className`` suppresses the default entirely — otherwise a
 * caller's ``rounded-full`` / ``rounded-none`` would win its own merge
 * group while the species' corner override (``rounded-bl-sm``) survived,
 * leaving a stray flattened corner on an intentionally round avatar.
 */
export function withSpeciesShape(shape: string, className?: string): string {
  const hasRadiusOverride = className ? /(^|\s)rounded/.test(className) : false;
  return cn(hasRadiusOverride ? undefined : shape, className);
}
