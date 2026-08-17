import { useOutletContext } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen01Icon as Book, Delete02Icon as Trash } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import { agentBreadcrumbs } from "@/components/agent/agentBreadcrumbs";
import type { AgentOutletContext } from "@/components/agent/AgentShell";
import {
  installAgentSkill,
  listAgentSkills,
  listOrgSkills,
  uninstallAgentSkill,
  type AgentSkill,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { errMsg, toast } from "@/lib/toast";
import { queryKeys } from "@/lib/queryKeys";
import { formatRelativeAgo } from "@/lib/formatting";

/** What skills this agent actually has, as it last reported them. */
export default function AgentSkillsPage() {
  const { orgId, agentId, profile, isLoading } = useOutletContext<AgentOutletContext>();
  const breadcrumb = agentBreadcrumbs(agentId, profile, "skills");

  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.agentSkills(orgId, agentId ?? ""),
    queryFn: () => listAgentSkills(orgId, agentId ?? ""),
    enabled: Boolean(orgId) && Boolean(agentId) && Boolean(profile?.is_operator),
  });
  const libraryQuery = useQuery({
    queryKey: queryKeys.skills(orgId),
    queryFn: () => listOrgSkills(orgId),
    enabled: Boolean(orgId) && Boolean(profile?.is_operator),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.skills(orgId) });
  };
  const install = useMutation({
    mutationFn: (skillId: string) => installAgentSkill(orgId, agentId ?? "", skillId),
    onSuccess: () => { invalidate(); toast.success("Installing…"); },
    onError: (e) => { toast.error(errMsg(e)); },
  });
  const uninstall = useMutation({
    mutationFn: (installId: string) => uninstallAgentSkill(orgId, agentId ?? "", installId),
    onSuccess: () => { invalidate(); toast.success("Removing…"); },
    onError: (e) => { toast.error(errMsg(e)); },
  });

  if (!profile?.is_operator) {
    return (
      <div className="space-y-6 pb-16">
        <PageHeader breadcrumb={breadcrumb} />
        <div className="py-12 text-center text-sm text-muted-foreground">
          {!profile
            ? isLoading
              ? "Loading…"
              : "Couldn't load this agent."
            : "Only this agent's operator can view its skills."}
        </div>
      </div>
    );
  }

  const skills = query.data?.skills ?? [];
  const sync = query.data?.sync;
  const installedSkillIds = new Set(skills.map((s) => s.skill_id).filter(Boolean));
  const installable = (libraryQuery.data?.skills ?? []).filter(
    (s) => !s.is_draft && !installedSkillIds.has(s.skill_id),
  );

  return (
    <div className="space-y-6 pb-16">
      <PageHeader
        breadcrumb={breadcrumb}
        actions={
          installable.length > 0 ? (
            <Select
              value=""
              onValueChange={(v) => { if (v) install.mutate(v); }}
              disabled={install.isPending}
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Add a skill" />
              </SelectTrigger>
              <SelectContent>
                {installable.map((s) => (
                  <SelectItem key={s.skill_id} value={s.skill_id}>
                    {s.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null
        }
      />

      {query.isPending ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : query.isError ? (
        <div className="text-sm text-destructive">{errMsg(query.error)}</div>
      ) : skills.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 px-6 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Icon icon={Book} className="size-6" />
          </span>
          <h2 className="mt-4 text-base font-semibold tracking-tight text-foreground">
            Nothing reported yet
          </h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {sync?.last_reported_at
              ? "This agent reported no skills."
              : "This agent hasn't reported its skills yet. It needs a plugin version that supports skills."}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
          {skills.map((s) => (
            <SkillRow
              key={s.install_id}
              skill={s}
              onRemove={
                s.managed_by === "clawbits"
                  ? () => { uninstall.mutate(s.install_id); }
                  : undefined
              }
            />
          ))}
        </ul>
      )}

      {sync?.last_reported_at && (
        <p className="text-caption text-muted-foreground">
          Reported {formatRelativeAgo(sync.last_reported_at)}
          {sync.scanned_roots?.length
            ? ` from ${String(sync.scanned_roots.length)} folder${sync.scanned_roots.length === 1 ? "" : "s"}`
            : ""}
          . Skills added here are managed by Clawbits; the rest are shown as found.
        </p>
      )}
    </div>
  );
}

function SkillRow({ skill, onRemove }: { skill: AgentSkill; onRemove?: () => void }) {
  // eligible === false means the loader found the skill but a requirement is
  // missing, so the agent will never use it. Worth saying out loud.
  const blocked = skill.eligible === false;
  // No optimistic success: the amber state stands until the agent confirms.
  const pending = skill.sync_status === "requested" || skill.sync_status === "removing";
  const missingBins = skill.missing?.bins ?? [];

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon icon={Book} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{skill.name}</span>
          {skill.reported_source && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground">
              {sourceLabel(skill.reported_source)}
            </span>
          )}
          {blocked && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-caption font-medium text-amber-700 dark:text-amber-400">
              Not usable
            </span>
          )}
          {pending && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-caption font-medium text-amber-700 dark:text-amber-400">
              {skill.sync_status === "removing" ? "Removing…" : "Installing…"}
            </span>
          )}
          {skill.sync_status === "failed" && (
            <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-caption font-medium text-destructive">
              Failed
            </span>
          )}
        </div>
        {skill.description && (
          <p className="mt-0.5 line-clamp-2 text-caption text-muted-foreground">
            {skill.description}
          </p>
        )}
        {skill.sync_error && (
          <p className="mt-1 text-caption text-destructive">{skill.sync_error}</p>
        )}
        {blocked && missingBins.length > 0 && (
          <p className="mt-1 text-caption text-amber-700 dark:text-amber-400">
            Needs {missingBins.join(", ")} on the agent.
          </p>
        )}
      </div>
      <span className="shrink-0 font-mono text-caption text-muted-foreground">
        {skill.slug}
      </span>
      {onRemove && (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove ${skill.name}`}
          onClick={onRemove}
        >
          <Icon icon={Trash} className="size-4" />
        </Button>
      )}
    </li>
  );
}

function sourceLabel(source: string): string {
  if (source === "clawhub") return "ClawHub";
  if (source === "path" || source === "git") return "Installed";
  return source;
}
