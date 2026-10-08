import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { ChevronDown } from "lucide-react";
import { Icon } from "@/components/Icon";
import { useAgentTab } from "@/components/agent/agentTabContext";
import { Squircle, SquircleDefs } from "@/components/home/tiles";
import { SettingsRow, SettingsSection, SettingsTile } from "@/components/settings/Settings";
import { SidePanel } from "@/components/sidebars/SidePanel";
import { AgentSkillPanel } from "@/components/skills/AgentSkillPanel";
import { SkillForge } from "@/components/skills/SkillForge";
import { SkillGlyph } from "@/components/skills/SkillGlyph";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  adoptAgentSkill,
  getAgentSkillDraft,
  installAgentSkill,
  listAgentSkills,
  listOrgSkills,
  type AgentSkill,
  type SkillDraft,
} from "@/lib/api";
import { confirm } from "@/lib/confirm";
import { formatRelativeAgo } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";
import { RUNTIME_CAN_RECEIVE, RUNTIME_LABELS, agentRuntime, installPill } from "@/lib/skills";
import { errMsg, toast } from "@/lib/toast";

const PENDING = new Set(["requested", "removing"]);
const SELECTED = "bg-foreground/8 has-[a:hover]:bg-foreground/8 has-[a:focus-visible]:bg-foreground/8";

/** What skills this agent actually has, as it last reported them. */
export default function AgentSkillsPage() {
  const { orgId, agentId, profile } = useAgentTab();
  const { installId } = useParams<{ installId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showBundled, setShowBundled] = useState(false);
  const [forging, setForging] = useState<{ installId: string; draft: SkillDraft } | null>(null);

  const query = useQuery({
    queryKey: queryKeys.agentSkills(orgId, agentId),
    queryFn: () => listAgentSkills(orgId, agentId),
    refetchInterval: (q) => (q.state.data?.skills.some((s) => PENDING.has(s.sync_status)) ? 5_000 : false),
  });
  const libraryQuery = useQuery({
    queryKey: queryKeys.skills(orgId),
    queryFn: () => listOrgSkills(orgId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.skills(orgId) });
  };
  const install = useMutation({
    mutationFn: (skillId: string) => installAgentSkill(orgId, agentId, skillId),
    onSuccess: () => {
      invalidate();
      toast.success("Installing…");
    },
  });
  const adopt = useMutation({
    mutationFn: (v: { installId: string; skillId: string }) => adoptAgentSkill(orgId, agentId, v.installId, v.skillId),
    onSuccess: () => {
      invalidate();
      toast.success("Adopting…");
    },
  });
  const loadDraft = useMutation({
    mutationFn: (id: string) => getAgentSkillDraft(orgId, agentId, id),
    onSuccess: (draft, id) => {
      setForging({ installId: id, draft });
    },
  });

  const base = `/agents/${encodeURIComponent(agentId)}/skills`;
  const skills = query.data?.skills ?? [];
  const library = libraryQuery.data?.skills ?? [];
  const selected = skills.find((s) => s.install_id === installId);
  const runtime = agentRuntime(profile.agent_type);
  const installable = library.filter(
    (s) => !s.is_draft && s.runtimes.includes(runtime) && !skills.some((i) => i.skill_id === s.skill_id),
  );

  if (installId && query.data && !selected) return <Navigate to={base} replace />;

  if (!RUNTIME_CAN_RECEIVE[runtime]) {
    return (
      <SettingsSection>
        <SettingsRow
          title={`Skills aren't available for ${RUNTIME_LABELS[runtime]} agents yet`}
          description="They install on OpenClaw agents today."
        />
      </SettingsSection>
    );
  }

  if (!query.data) {
    return query.isError ? (
      <SettingsSection>
        <SettingsRow title="Couldn't load skills" error={errMsg(query.error, "Try again in a moment")} />
      </SettingsSection>
    ) : (
      <SettingsSection stack>
        {[0, 1, 2].map((i) => (
          <SettingsTile
            key={i}
            leading={<Skeleton className="size-10 rounded-[12px]" />}
            title={<Skeleton className="h-3.5 w-32 rounded" />}
            subtitle={<Skeleton className="mt-1.5 h-3 w-48 rounded" />}
          />
        ))}
      </SettingsSection>
    );
  }

  const close = () => {
    void navigate(base, { replace: true });
  };

  // The agent's copy goes through the editor first, since its text is untrusted.
  // When the library already has that name, a new skill would clash, so that one is adopted as is.
  const startAdopt = (s: AgentSkill) => {
    const existing = library.find((l) => l.slug === s.slug);
    if (!existing) {
      loadDraft.mutate(s.install_id);
      return;
    }
    void confirm({
      title: `Adopt ${s.name}?`,
      description: `The library already has ${existing.display_name}. Clawbits will manage it here and replace the agent's copy with the library version.`,
      confirmLabel: "Adopt",
    }).then((ok) => {
      if (ok) adopt.mutate({ installId: s.install_id, skillId: existing.skill_id });
    });
  };

  const tile = (s: AgentSkill) => {
    const lib = library.find((l) => l.skill_id === s.skill_id);
    const bins = s.missing?.bins ?? [];
    const fact = s.skill_id
      ? s.reported_version && `v${s.reported_version}`
      : s.reported_source === "clawhub" && "From ClawHub";
    return (
      <SettingsTile
        key={s.install_id}
        leading={<SkillGlyph skill={{ slug: s.slug, icon_emoji: lib?.icon_emoji ?? null }} />}
        title={lib?.display_name ?? s.name}
        href={`${base}/${encodeURIComponent(s.install_id)}`}
        subtitle={
          s.eligible === false && bins.length > 0
            ? `Needs ${bins.join(", ")} on the agent.`
            : (s.description ?? lib?.summary)
        }
        aside={fact}
        pill={installPill(s)}
        className={s.install_id === installId ? SELECTED : undefined}
      />
    );
  };

  const { sync } = query.data;
  const managed = skills.filter((s) => s.managed_by === "clawbits");
  const external = skills.filter((s) => s.managed_by === "external");
  const bundled = sync.bundled ?? [];
  const reported = formatRelativeAgo(sync.last_reported_at);

  return (
    <>
      <SquircleDefs />

      {sync.reporter === "never_reported" && (
        <SettingsSection>
          <SettingsRow
            title="No report from this agent yet"
            description="Skills need the Clawbits tools plugin on this agent. Anything added here waits until it reports."
          />
        </SettingsSection>
      )}

      <SettingsSection
        label="From the library"
        stack={managed.length > 0}
        aside={
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={install.isPending}
              className="inline-flex items-center gap-1 rounded font-medium text-foreground outline-none hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Icon icon={PlusSignIcon} className="size-[13px]" />
              Add skill
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {installable.map((s) => (
                <DropdownMenuItem
                  key={s.skill_id}
                  onClick={() => {
                    install.mutate(s.skill_id);
                  }}
                >
                  <SkillGlyph skill={s} size={20} />
                  {s.display_name}
                </DropdownMenuItem>
              ))}
              {installable.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onClick={() => {
                  void navigate("/skills");
                }}
              >
                Open library
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      >
        {managed.length > 0 ? managed.map(tile) : <SettingsRow title="Nothing from the library yet" />}
      </SettingsSection>

      {(external.length > 0 || sync.reporter !== "never_reported") && (
        <SettingsSection
          label="Found on the agent"
          stack={external.length > 0}
          footer={
            sync.reporter === "stale"
              ? `Last report ${reported}. The agent may be offline, so this may not match what it has now.`
              : sync.reporter === "ok"
                ? `Reported ${reported}.`
                : undefined
          }
        >
          {external.length > 0 ? external.map(tile) : <SettingsRow title="Nothing else on this agent" />}
        </SettingsSection>
      )}

      {bundled.length > 0 && (
        <SettingsSection label="Built in" stack footer="They come with OpenClaw and can't be managed here.">
          <SettingsTile
            leading={
              <Squircle size={40} glass={false} className="bg-muted text-muted-foreground">
                <Icon icon={BookOpen01Icon} className="size-5" />
              </Squircle>
            }
            title={
              <button
                type="button"
                aria-expanded={showBundled}
                onClick={() => {
                  setShowBundled((v) => !v);
                }}
                className="block w-full truncate text-left outline-none after:absolute after:inset-0"
              >
                {bundled.length} skill{bundled.length === 1 ? "" : "s"} included with OpenClaw
              </button>
            }
            subtitle={bundled.map((b) => b.slug).join(", ")}
            end={
              <span className="disclosure-chevron inline-flex text-muted-foreground" data-open={showBundled}>
                <ChevronDown className="size-4" />
              </span>
            }
            className="has-[button:hover]:bg-foreground/4 has-[button:focus-visible]:bg-foreground/4"
          />
          {showBundled && (
            <ul className="rounded-[14px] bg-card py-2 pr-3 pl-[63px] text-[13px]">
              {bundled.map((b) => (
                <li key={b.slug} className="flex min-w-0 gap-2 py-1">
                  <span className="shrink-0 font-medium">{b.slug}</span>
                  {b.description && <span className="truncate text-muted-foreground">{b.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </SettingsSection>
      )}

      <SkillForge
        open={forging != null}
        draft={forging?.draft}
        onCreated={(skill) => {
          if (forging) adopt.mutate({ installId: forging.installId, skillId: skill.skill_id });
        }}
        onOpenChange={() => {
          setForging(null);
        }}
      />

      <SidePanel open={selected != null} title="Skill" onClose={close}>
        {selected && (
          <AgentSkillPanel
            key={selected.install_id}
            skill={selected}
            library={library.find((l) => l.skill_id === selected.skill_id)}
            adopting={loadDraft.isPending || adopt.isPending}
            onAdopt={() => {
              startAdopt(selected);
            }}
            onRemoved={close}
          />
        )}
      </SidePanel>
    </>
  );
}
