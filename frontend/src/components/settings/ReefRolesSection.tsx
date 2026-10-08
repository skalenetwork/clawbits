import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ModalHeader, ModalList, ModalNote, ModalPanel, ModalRow, ModalSearch } from "@/components/modals/Modal";
import { SettingsRow, SettingsRowSkeleton, SettingsSection } from "@/components/settings/Settings";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listOrgMembers, listReefRoleAccess, setReefRoleAccess, type ReefRoleAccess } from "@/lib/api";
import { formatRoleResources, roleRuntime, RUNTIME_LOGO } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg } from "@/lib/toast";

const MODES: { value: ReefRoleAccess["mode"]; label: string }[] = [
  { value: "everyone", label: "Everyone" },
  { value: "selected", label: "Specific people" },
  { value: "off", label: "Off" },
];

export function ReefRolesSection({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const roles = useQuery({ queryKey: queryKeys.reefRoleAccess(orgId), queryFn: () => listReefRoleAccess(orgId) });
  const members = useQuery({
    queryKey: queryKeys.orgMembers(orgId),
    queryFn: () => listOrgMembers(orgId),
    enabled: editing !== null,
  });
  const save = useMutation({
    mutationFn: ({ role, access }: { role: string; access: ReefRoleAccess }) => setReefRoleAccess(orgId, role, access),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.reefRoles(orgId) }),
  });

  const granted = new Set(roles.data?.find((r) => r.role.name === editing)?.access.members);
  const needle = query.trim().toLowerCase();
  const shown = (members.data?.members ?? []).filter((m) => (m.display_name ?? m.email).toLowerCase().includes(needle));

  return (
    <SettingsSection label="Roles" footer="Who can create agents from each role. Agents already running keep running.">
      {roles.isPending ? (
        [0, 1].map((i) => <SettingsRowSkeleton key={i} />)
      ) : roles.isError ? (
        <SettingsRow title="Couldn't load roles" error={errMsg(roles.error, "Try again in a moment")} />
      ) : roles.data.length === 0 ? (
        <SettingsRow title={<span className="font-normal text-muted-foreground">No role points its agents here</span>} />
      ) : (
        roles.data.map(({ role, access }) => (
          <SettingsRow
            key={role.name}
            leading={<img src={RUNTIME_LOGO[roleRuntime(role)]} alt="" className="size-8 rounded-lg" />}
            title={role.name}
            description={formatRoleResources(role.resources)}
            control={
              <>
                {access.mode === "selected" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditing(role.name);
                    }}
                  >
                    {access.members.length} {access.members.length === 1 ? "person" : "people"}
                  </Button>
                )}
                <Select
                  value={access.mode}
                  items={MODES}
                  disabled={save.isPending}
                  onValueChange={(mode) => {
                    if (!mode) return;
                    save.mutate({ role: role.name, access: { ...access, mode } });
                    if (mode === "selected") setEditing(role.name);
                  }}
                >
                  <SelectTrigger size="sm" aria-label={`Who can use ${role.name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODES.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            }
          />
        ))
      )}

      <ModalPanel
        open={editing !== null}
        onOpenChange={(open) => {
          if (open) return;
          setEditing(null);
          setQuery("");
        }}
        kind="picker"
      >
        <ModalHeader title={editing ?? ""} description="Only these people can create agents from this role.">
          <ModalSearch value={query} onChange={setQuery} placeholder="Search people" />
        </ModalHeader>
        <ModalList>
          {members.isPending ? (
            <ModalNote>Loading…</ModalNote>
          ) : members.isError ? (
            <ModalNote>{errMsg(members.error, "Couldn't load people")}</ModalNote>
          ) : shown.length === 0 ? (
            <ModalNote>No matches</ModalNote>
          ) : (
            shown.map((m) => {
              const has = granted.has(m.human_id);
              const next = has ? [...granted].filter((h) => h !== m.human_id) : [...granted, m.human_id];
              return (
                <ModalRow
                  key={m.human_id}
                  kind="human"
                  name={m.display_name ?? m.email}
                  avatarUrl={m.avatar?.url}
                  note={has ? "Can use" : undefined}
                  action={{
                    label: has ? "Remove" : "Add",
                    destructive: has,
                    disabled: save.isPending,
                    onClick: () => {
                      if (editing) save.mutate({ role: editing, access: { mode: "selected", members: next } });
                    },
                  }}
                />
              );
            })
          )}
        </ModalList>
      </ModalPanel>
    </SettingsSection>
  );
}
