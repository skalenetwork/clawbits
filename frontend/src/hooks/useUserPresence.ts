import { useSyncExternalStore } from "react";
import { updateAgentPresence } from "@/hooks/useAgentPresence";
import type { GlobalUserStatus, MmChannelMember } from "@/lib/api";

export interface UserPresence {
  humanId: number;
  status: GlobalUserStatus;
  lastSeenAt: string | null;
  lastSeenLabel: string | null;
}

let presenceByHuman: ReadonlyMap<number, UserPresence> = new Map();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function updateUserPresence(entries: readonly UserPresence[]): void {
  let next: Map<number, UserPresence> | null = null;
  for (const entry of entries) {
    const current = (next ?? presenceByHuman).get(entry.humanId);
    if (
      current?.status === entry.status &&
      current.lastSeenAt === entry.lastSeenAt &&
      current.lastSeenLabel === entry.lastSeenLabel
    ) {
      continue;
    }
    next ??= new Map(presenceByHuman);
    next.set(entry.humanId, entry);
  }
  if (!next) return;
  presenceByHuman = next;
  for (const listener of listeners) listener();
}

export function seedMemberPresence(members: readonly MmChannelMember[]): void {
  updateUserPresence(
    members.flatMap((m) =>
      m.human_id != null && m.status != null
        ? [{
            humanId: m.human_id,
            status: m.status,
            lastSeenAt: m.last_seen_at,
            lastSeenLabel: m.last_seen_label ?? null,
          }]
        : [],
    ),
  );
  updateAgentPresence(
    members.flatMap((m) =>
      m.agent_id != null ? [{ agentId: m.agent_id, lastAliveAt: m.last_alive_at ?? null }] : [],
    ),
  );
}

function useUserField<T>(
  humanId: number | null | undefined,
  read: (entry: UserPresence | undefined) => T,
): T {
  return useSyncExternalStore(subscribe, () =>
    read(humanId == null ? undefined : presenceByHuman.get(humanId)),
  );
}

export function useUserStatus(humanId: number | null | undefined): GlobalUserStatus {
  return useUserField(humanId, (entry) => entry?.status ?? "offline");
}

export function useUserLastSeen(humanId: number | null | undefined): string | null {
  return useUserField(humanId, (entry) => entry?.lastSeenAt ?? null);
}

export function useUserLastSeenLabel(humanId: number | null | undefined): string | null {
  return useUserField(humanId, (entry) => entry?.lastSeenLabel ?? null);
}
