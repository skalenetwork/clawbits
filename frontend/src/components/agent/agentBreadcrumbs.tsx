/**
 * Shared breadcrumb trail for the agent section, so every agent page renders an
 * identical, jump-free trail: All › {avatar} {name} › {section}. The agent crumb
 * carries the agent's avatar; each section crumb carries its own icon.
 */
import {
  Robot02Icon as Bot,
  Clock05Icon,
  Mail01Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import type { MouseEvent } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import type { Crumb } from "@/components/Breadcrumbs";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { agentDisplay } from "@/lib/agentDisplay";
import type { AgentProfile } from "@/lib/api";
import { cn } from "@/lib/utils";

export type AgentSection = "inbox" | "automations" | "manage";

const SECTION: Record<AgentSection, { label: string; icon: IconSvgElement }> = {
  inbox: { label: "Inbox", icon: Mail01Icon },
  automations: { label: "Automations", icon: Clock05Icon },
  manage: { label: "Manage", icon: Settings02Icon },
};

export function agentBreadcrumbs(
  agentId: string | null,
  profile: AgentProfile | null,
  section?: AgentSection,
  opts?: {
    /** Click interceptor for the "All" crumb — used by the agent card page to
     *  morph the centered card back into its grid slot (reverse hero morph). */
    onAll?: (e: MouseEvent) => void;
    /** A 4th crumb for an item open inside the section (e.g. a message's
     *  subject) — the section crumb then links back to the section root. */
    detail?: { label: string };
  },
): Crumb[] {
  const name = profile ? agentDisplay(profile) : (agentId ?? "Agent");
  const base = `/agents/${encodeURIComponent(agentId ?? "")}`;
  const crumbs: Crumb[] = [
    { label: "All", to: "/agents", icon: Bot, onNavigate: opts?.onAll },
    {
      label: name,
      // Linked only when it's not the current page (i.e. on a subpage).
      to: section ? base : undefined,
      leading: (
        <AgentFaceAvatar
          size={18}
          name={name}
          src={profile?.avatar?.url}
          className={cn("rounded-full", section && "grayscale")}
        />
      ),
    },
  ];
  if (section) {
    crumbs.push({
      label: SECTION[section].label,
      icon: SECTION[section].icon,
      to: opts?.detail ? `${base}/${section}` : undefined,
    });
    if (opts?.detail) crumbs.push({ label: opts.detail.label });
  }
  return crumbs;
}
