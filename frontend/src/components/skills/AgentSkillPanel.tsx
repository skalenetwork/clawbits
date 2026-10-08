import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useAgentTab } from "@/components/agent/agentTabContext";
import { TilePill } from "@/components/settings/Settings";
import { SkillDocument } from "@/components/skills/SkillDocument";
import { SkillGlyph } from "@/components/skills/SkillGlyph";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { agentDisplay } from "@/lib/agentDisplay";
import {
  getAgentSkillContent,
  getSkill,
  listSkillVersions,
  pinAgentSkill,
  uninstallAgentSkill,
  type AgentSkill,
  type Skill,
} from "@/lib/api";
import { confirm } from "@/lib/confirm";
import { queryKeys } from "@/lib/queryKeys";
import { RESERVED_SLUG_PREFIX, installPill } from "@/lib/skills";
import type { Pill } from "@/lib/status";
import { errMsg, toast } from "@/lib/toast";

const LATEST = "latest";
const LABEL = "text-[12px] font-medium text-muted-foreground";

const OMITTED: Record<string, string> = {
  too_large: "This SKILL.md is over 64 KiB, so the agent doesn't send its text.",
  not_reported: "The agent hasn't sent this skill's text yet.",
};

function StateRow({ pill, fact, children }: { pill: Pill | null; fact: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-y border-foreground/8 py-2.5 text-[13px] text-muted-foreground tabular-nums">
      <span className="flex min-w-0 items-center gap-2">
        {fact}
        {pill && <TilePill {...pill} />}
      </span>
      {children}
    </div>
  );
}

/** A library install's state with the skill's history, so it can say "Pinned to" and "N behind", and its version pin. */
function ManagedState({ skill, skillId }: { skill: AgentSkill; skillId: string }) {
  const { orgId, agentId } = useAgentTab();
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: queryKeys.skill(orgId, skillId),
    queryFn: () => getSkill(orgId, skillId),
  });
  const versionsQuery = useQuery({
    queryKey: queryKeys.skillVersions(orgId, skillId),
    queryFn: () => listSkillVersions(orgId, skillId),
  });
  const pin = useMutation({
    mutationFn: (value: string) =>
      pinAgentSkill(
        orgId,
        agentId,
        skill.install_id,
        value === LATEST ? { channel: "latest" } : { pinned_version_id: value },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills(orgId) });
    },
  });

  const install = detailQuery.data?.agents?.find((a) => a.install_id === skill.install_id);
  const versions = versionsQuery.data?.versions;
  const latest = detailQuery.data?.latest_version;
  const items = versions && [
    { value: LATEST, label: latest ? `Latest (v${latest})` : "Latest" },
    ...versions.map((v) => ({ value: v.version_id, label: `v${v.version}` })),
  ];
  return (
    <StateRow
      pill={installPill({ ...skill, channel: install?.channel, installed_version: skill.reported_version }, versions)}
      fact={skill.reported_version && `v${skill.reported_version}`}
    >
      {install && items && skill.sync_status !== "removing" && (
        <Select
          value={install.pinned_version_id ?? LATEST}
          items={items}
          disabled={pin.isPending}
          onValueChange={(value) => {
            if (value) pin.mutate(value);
          }}
        >
          <SelectTrigger size="sm" aria-label="Version">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </StateRow>
  );
}

/** One skill on one agent: its state, where it lives, and the SKILL.md it reads. */
export function AgentSkillPanel({
  skill,
  library,
  adopting,
  onAdopt,
  onRemoved,
}: {
  skill: AgentSkill;
  library?: Pick<Skill, "display_name" | "icon_emoji" | "summary">;
  adopting: boolean;
  onAdopt: () => void;
  onRemoved: () => void;
}) {
  const { orgId, agentId, profile } = useAgentTab();
  const queryClient = useQueryClient();
  const contentQuery = useQuery({
    queryKey: queryKeys.agentSkillContent(orgId, agentId, skill.install_id),
    queryFn: () => getAgentSkillContent(orgId, agentId, skill.install_id),
  });
  const remove = useMutation({
    mutationFn: () => uninstallAgentSkill(orgId, agentId, skill.install_id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills(orgId) });
      toast.success("Removing…");
      onRemoved();
    },
  });

  const name = library?.display_name ?? skill.name;
  const description = skill.description ?? library?.summary;
  const live = skill.skill_id != null && skill.sync_status !== "removing";
  const adoptable = skill.managed_by === "external" && skill.has_content && !skill.slug.startsWith(RESERVED_SLUG_PREFIX);
  const missingBins = skill.missing?.bins ?? [];
  const content = contentQuery.data;

  return (
    <div className="flex flex-col gap-4 px-2.5 pb-4">
      <div className="flex items-center gap-[11px]">
        <SkillGlyph skill={{ slug: skill.slug, icon_emoji: library?.icon_emoji ?? null }} />
        <div className="min-w-0">
          <h3 className="truncate text-base leading-6 font-semibold">{name}</h3>
          <p className="truncate text-[12.5px] text-muted-foreground">
            {skill.skill_id ? (
              <Link
                to={`/skills/${encodeURIComponent(skill.skill_id)}`}
                className="rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                Open in library
              </Link>
            ) : (
              `Found on ${agentDisplay(profile)}`
            )}
          </p>
        </div>
      </div>

      {skill.skill_id ? (
        <ManagedState skill={skill} skillId={skill.skill_id} />
      ) : (
        <StateRow
          pill={installPill(skill)}
          fact={skill.reported_source === "clawhub" ? "From ClawHub" : "Not managed by Clawbits"}
        >
          {skill.reported_version && <span>v{skill.reported_version}</span>}
        </StateRow>
      )}

      {skill.sync_error && (
        <p className="font-mono text-[12.5px] text-destructive wrap-anywhere">{skill.sync_error}</p>
      )}
      {skill.eligible === false && missingBins.length > 0 && (
        <p className="text-[13px]">Needs {missingBins.join(", ")} on the agent.</p>
      )}

      {adoptable && (
        <div className="flex flex-col items-start gap-2">
          <Button size="sm" disabled={adopting} onClick={onAdopt}>
            Adopt
          </Button>
          <p className="text-[12.5px] text-muted-foreground">Adopt it to manage it from the library.</p>
        </div>
      )}
      {live && (
        <Button
          variant="destructive"
          size="sm"
          className="self-start"
          disabled={remove.isPending}
          onClick={() => {
            void confirm({
              title: `Remove ${name}?`,
              description: "Clawbits deletes its folder from the agent. The library keeps the skill.",
              confirmLabel: "Remove",
            }).then((ok) => {
              if (ok) remove.mutate();
            });
          }}
        >
          Remove
        </Button>
      )}

      {(description || skill.reported_path) && (
        <dl className="flex flex-col gap-3 text-[13px]">
          {description && (
            <div className="flex flex-col gap-1">
              <dt className={LABEL}>When to use it</dt>
              <dd className="wrap-anywhere">{description}</dd>
            </div>
          )}
          {skill.reported_path && (
            <div className="flex flex-col gap-1">
              <dt className={LABEL}>File on the agent</dt>
              <dd className="font-mono text-[12px] wrap-anywhere">{skill.reported_path}</dd>
            </div>
          )}
        </dl>
      )}

      <section className="flex flex-col gap-2 border-t border-foreground/8 pt-4">
        <h4 className={LABEL}>SKILL.md</h4>
        {contentQuery.isError ? (
          <p className="text-[13px] text-destructive">{errMsg(contentQuery.error)}</p>
        ) : !content ? (
          <Skeleton className="h-24 w-full rounded-[10px]" />
        ) : content.skill_md == null ? (
          <p className="text-[13px] text-muted-foreground">
            {OMITTED[content.omitted_reason ?? ""] ?? OMITTED.not_reported}
          </p>
        ) : (
          <SkillDocument markdown={content.skill_md} displayName={name} compact />
        )}
      </section>
    </div>
  );
}
