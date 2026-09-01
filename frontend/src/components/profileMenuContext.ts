/**
 * The profile-menu context and the hook triggers use to open it. Split from
 * ``ProfileMenu.tsx`` so that file exports only components — a module that
 * mixes component and non-component exports drops out of fast refresh.
 */
import { createContext, useCallback, useContext, type MouseEvent } from "react";

import type { MmChannelMember } from "@/lib/api";

export interface ProfileMenuTarget {
  member: MmChannelMember;
  /** Literal "@handle" used as the secondary line and copy/mention payload. */
  handleText: string;
  /** Anchor element the popover should align to. */
  anchor: HTMLElement;
}

export interface ProfileMenuContextValue {
  open: (target: ProfileMenuTarget) => void;
}

export const ProfileMenuContext = createContext<ProfileMenuContextValue | null>(null);

/** Hook the trigger components use. Returns a click handler that opens
 *  the shared popover anchored at the clicked element. Safe to call
 *  outside the provider — without a provider the handler is a no-op. */
export function useProfileMenuTrigger(
  member: MmChannelMember | null,
  handleText: string,
): (e: MouseEvent<HTMLElement>) => void {
  const ctx = useContext(ProfileMenuContext);
  return useCallback(
    (e: MouseEvent<HTMLElement>) => {
      if (!ctx || !member) return;
      e.preventDefault();
      e.stopPropagation();
      ctx.open({ member, handleText, anchor: e.currentTarget });
    },
    [ctx, member, handleText],
  );
}
