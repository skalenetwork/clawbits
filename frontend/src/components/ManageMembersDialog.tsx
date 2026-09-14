import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { agentDisplay } from "@/lib/agentDisplay";
import {
  ModalButton,
  ModalFooter,
  ModalHeader,
  ModalList,
  ModalNote,
  ModalPanel,
  ModalRow,
  ModalSearch,
  ModalSection,
  ModalTabs,
  type ModalTab,
} from "@/components/modals/Modal";
import { useAuth } from "@/context/AuthContext";
import {
  addMmChannelMember,
  getAgents,
  listMmChannelMembers,
  listOrgMembers,
  removeMmChannelMember,
  type MmMemberType,
} from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";

type Action = "Add" | "Remove" | "Leave";

interface Entry {
  kind: MmMemberType;
  id: string;
  name: string;
  seed?: string;
  avatarUrl?: string | null;
  action: Action;
}

const TABS: readonly ModalTab<"all" | MmMemberType>[] = [
  { id: "all", label: "All" },
  { id: "human", label: "People" },
  { id: "agent", label: "Agents" },
];

const TOASTS: Record<Action, { done: string; failed: string }> = {
  Add: { done: "Member added", failed: "Couldn't add member" },
  Remove: { done: "Member removed", failed: "Failed to remove" },
  Leave: { done: "You left the channel", failed: "Failed to remove" },
};

const keyOf = (e: Entry) => `${e.kind}:${e.id}`;

export default function ManageMembersDialog({
  open,
  onOpenChange,
  channelId,
  orgId,
  channelLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  orgId: string;
  channelLabel: string;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | MmMemberType>("all");

  const setOpen = (next: boolean) => {
    if (!next) {
      setQuery("");
      setTab("all");
    }
    onOpenChange(next);
  };

  const membersQuery = useQuery({
    queryKey: queryKeys.mm.channelMembers(channelId),
    queryFn: () => listMmChannelMembers(channelId),
    enabled: Boolean(channelId && open),
  });
  const orgMembersQuery = useQuery({
    queryKey: queryKeys.orgMembers(orgId),
    queryFn: () => listOrgMembers(orgId),
    enabled: Boolean(orgId && open),
  });
  const orgAgentsQuery = useQuery({
    queryKey: queryKeys.agents(orgId),
    queryFn: () => getAgents(orgId),
    enabled: Boolean(orgId && open),
  });

  const mutation = useMutation({
    mutationFn: (e: Entry) =>
      (e.action === "Add" ? addMmChannelMember : removeMmChannelMember)(channelId, e.id, e.kind),
    onSuccess: (_data, e) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.mm.channelMembers(channelId) });
      toast.success(TOASTS[e.action].done);
      if (e.action !== "Leave") return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
      setOpen(false);
      void navigate("/home", { replace: true });
    },
    onError: (err, e) => {
      toast.error(errMsg(err, TOASTS[e.action].failed));
    },
  });

  const members = membersQuery.data?.members ?? [];
  const inChannel = members.map((m): Entry =>
    m.agent_id
      ? { kind: "agent", id: m.agent_id, name: m.display_name || m.agent_id, avatarUrl: m.avatar?.url, action: "Remove" }
      : {
          kind: "human",
          id: String(m.human_id ?? ""),
          name: m.display_name || (m.human_id == null ? "Unknown" : `User ${String(m.human_id)}`),
          seed: m.human_id == null ? "user" : String(m.human_id),
          avatarUrl: m.avatar?.url,
          action: m.human_id === user?.id ? "Leave" : "Remove",
        },
  );
  const inKeys = new Set(inChannel.map(keyOf));
  const elsewhere = [
    ...(orgMembersQuery.data?.members ?? []).map((m): Entry => ({
      kind: "human",
      id: String(m.human_id),
      name: m.display_name ?? m.email,
      avatarUrl: m.avatar?.url,
      action: "Add",
    })),
    ...(orgAgentsQuery.data?.agents ?? []).map((a): Entry => ({
      kind: "agent",
      id: a.agent_id,
      name: agentDisplay(a),
      avatarUrl: a.avatar?.url,
      action: "Add",
    })),
  ].filter(e => !inKeys.has(keyOf(e)));

  const needle = query.trim().toLowerCase();
  const filtering = needle !== "" || tab !== "all";
  const keep = (e: Entry) => (tab === "all" || e.kind === tab) && e.name.toLowerCase().includes(needle);
  const directoryError = orgMembersQuery.error ?? orgAgentsQuery.error;
  const sections = [
    {
      label: "In this channel",
      entries: inChannel.filter(keep),
      loading: membersQuery.isLoading,
      error: null,
      empty: "No members yet.",
    },
    {
      label: "Elsewhere in the org",
      entries: elsewhere.filter(keep),
      loading: orgMembersQuery.isLoading || orgAgentsQuery.isLoading,
      error: directoryError,
      empty: "Everyone in the org is already in this channel.",
    },
  ];
  const noMatches =
    filtering && !directoryError && sections.every(s => !s.loading && s.entries.length === 0);

  return (
    <ModalPanel open={open} onOpenChange={setOpen} kind="picker">
      <ModalHeader title={channelLabel} description="Add or remove members of this channel.">
        <ModalSearch value={query} onChange={setQuery} placeholder="Search people and agents" />
        <div className="px-1.5 pb-1.5">
          <ModalTabs tabs={TABS} value={tab} onChange={setTab} label="Filter" />
        </div>
      </ModalHeader>

      <ModalList>
        {noMatches ? (
          <ModalNote>No matches</ModalNote>
        ) : (
          sections
            .filter(s => s.loading || s.error != null || s.entries.length > 0 || !filtering)
            .map(s => (
              <ModalSection key={s.label} label={s.label}>
                {s.loading ? (
                  <ModalNote>Loading…</ModalNote>
                ) : s.error ? (
                  <p className="px-2.5 py-2 text-[13px] text-destructive">
                    {`Couldn't load directory: ${errMsg(s.error)}`}
                  </p>
                ) : s.entries.length === 0 ? (
                  <ModalNote>{s.empty}</ModalNote>
                ) : (
                  s.entries.map(e => (
                    <ModalRow
                      key={keyOf(e)}
                      kind={e.kind}
                      name={e.name}
                      seed={e.seed}
                      avatarUrl={e.avatarUrl}
                      note={e.action === "Leave" ? "You" : undefined}
                      action={{
                        label: e.action,
                        onClick: () => { mutation.mutate(e); },
                        destructive: e.action !== "Add",
                        disabled: mutation.isPending,
                      }}
                    />
                  ))
                )}
              </ModalSection>
            ))
        )}
      </ModalList>

      <ModalFooter
        left={
          <span className="text-[12px] text-muted-foreground">
            {members.length} {members.length === 1 ? "member" : "members"}
          </span>
        }
      >
        <ModalButton onClick={() => { setOpen(false); }}>Done</ModalButton>
      </ModalFooter>
    </ModalPanel>
  );
}
