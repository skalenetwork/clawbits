import { createContext, useContext, type MouseEvent } from "react";

import type { MmChannelMember } from "@/lib/api";

export type ProfileMember = Pick<MmChannelMember, "agent_id" | "human_id" | "display_name" | "status" | "avatar">;

export interface ProfileMenuTarget {
  member: ProfileMember;
  handleText: string;
  anchor: HTMLElement;
}

export const ProfileMenuContext = createContext<{ open: (target: ProfileMenuTarget) => void } | null>(null);

export function useProfileMenuTrigger(member: ProfileMember | null, handleText: string) {
  const ctx = useContext(ProfileMenuContext);
  return (e: MouseEvent<HTMLElement>) => {
    if (!ctx || !member) return;
    e.preventDefault();
    e.stopPropagation();
    ctx.open({ member, handleText, anchor: e.currentTarget });
  };
}
