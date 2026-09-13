import { createContext, useContext, type MouseEvent } from "react";

import type { MmChannelMember } from "@/lib/api";

export interface ProfileMenuTarget {
  member: MmChannelMember;
  handleText: string;
  anchor: HTMLElement;
}

export const ProfileMenuContext = createContext<{ open: (target: ProfileMenuTarget) => void } | null>(null);

export function useProfileMenuTrigger(member: MmChannelMember | null, handleText: string) {
  const ctx = useContext(ProfileMenuContext);
  return (e: MouseEvent<HTMLElement>) => {
    if (!ctx || !member) return;
    e.preventDefault();
    e.stopPropagation();
    ctx.open({ member, handleText, anchor: e.currentTarget });
  };
}
