import {useState, type ReactNode} from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {Tick01Icon as Check} from "@hugeicons/core-free-icons";
import {AgentFaceAvatar} from "@/components/AgentFaceAvatar";
import {Icon} from "@/components/Icon";
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
} from "@/components/modals/Modal";
import {TilePill} from "@/components/settings/Settings";
import {useAuth} from "@/context/AuthContext";
import {agentDisplay} from "@/lib/agentDisplay";
import {
    getAgents,
    getSkill,
    installSkillOnAgents,
    listSkillVersions,
    type AgentUser,
    type Skill,
    type SkillInstallResult,
} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {RUNTIME_CAN_RECEIVE, RUNTIME_LABELS, agentRuntime, installPill} from "@/lib/skills";
import type {Pill} from "@/lib/status";
import {errMsg} from "@/lib/toast";

const SELECTED = (
    <>
        <Icon icon={Check} className="size-3.5 text-foreground"/>
        <span className="sr-only">Selected</span>
    </>
);

const RESULTS: Record<SkillInstallResult["status"], Pill> = {
    requested: {label: "Installing…"},
    already_installed: {label: "Already added"},
    refused: {label: "Not added", bad: true},
};

/** Put one library skill on several agents at once. Agents that already have it carry the tile's words, and agents the
 *  caller can't manage, or whose runtime can't receive skills, stay listed but disabled with the reason; the server
 *  checks each agent again and says why it refused any of them. */
export function AddToAgentsDialog({open, onOpenChange, skill}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    skill: Skill;
}) {
    return (
        <ModalPanel open={open} onOpenChange={onOpenChange} kind="picker">
            <AgentPicker skill={skill} onClose={() => { onOpenChange(false); }}/>
        </ModalPanel>
    );
}

function unavailableReason(agent: AgentUser): string | null {
    if (!agent.can_manage_contacts) return "Operator or owner only";
    const runtime = agentRuntime(agent.agent_type);
    return RUNTIME_CAN_RECEIVE[runtime] ? null : `${RUNTIME_LABELS[runtime]} isn't supported yet`;
}

function AgentPicker({skill, onClose}: {skill: Skill; onClose: () => void}) {
    const {activeOrgId} = useAuth();
    const orgId = activeOrgId ?? "";
    const queryClient = useQueryClient();
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set());

    const agentsQuery = useQuery({
        queryKey: queryKeys.agents(orgId),
        queryFn: () => getAgents(orgId),
    });
    const detailQuery = useQuery({
        queryKey: queryKeys.skill(orgId, skill.skill_id),
        queryFn: () => getSkill(orgId, skill.skill_id),
    });
    const versionsQuery = useQuery({
        queryKey: queryKeys.skillVersions(orgId, skill.skill_id),
        queryFn: () => listSkillVersions(orgId, skill.skill_id),
    });
    const install = useMutation({
        mutationFn: () => installSkillOnAgents(orgId, skill.skill_id, [...selected]),
        onSuccess: () => { void queryClient.invalidateQueries({queryKey: queryKeys.skills(orgId)}); },
    });

    const agents = agentsQuery.data?.agents ?? [];
    const byId = new Map(agents.map(a => [a.agent_id, a]));

    if (install.data) {
        return (
            <>
                <ModalHeader title={`Adding ${skill.display_name}`}/>
                <ModalList>
                    {install.data.results.map(result => {
                        const agent = byId.get(result.agent_id);
                        const name = agent ? agentDisplay(agent) : result.agent_id;
                        return (
                            <div key={result.agent_id} className="flex items-start gap-2.5 rounded-md px-2.5 py-2 text-[13px]">
                                <AgentFaceAvatar size={20} name={name} src={agent?.avatar?.url} className="shrink-0"/>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate font-medium">{name}</div>
                                    {result.detail && <div className="text-[12px] text-muted-foreground">{result.detail}</div>}
                                </div>
                                <TilePill {...RESULTS[result.status]}/>
                            </div>
                        );
                    })}
                </ModalList>
                <ModalFooter>
                    <ModalButton tone="primary" onClick={onClose}>Done</ModalButton>
                </ModalFooter>
            </>
        );
    }

    const present = new Map(
        (detailQuery.data?.agents ?? []).filter(a => a.sync_status !== "removing").map(a => [a.agent_id, a]),
    );
    const needle = query.trim().toLowerCase();
    const rows = agents
        .map(agent => ({
            agent,
            name: agentDisplay(agent),
            install: present.get(agent.agent_id),
            reason: unavailableReason(agent),
        }))
        .filter(row => row.name.toLowerCase().includes(needle));
    const added = rows.flatMap(row => (row.install ? [{...row, install: row.install}] : []));
    const available = rows.filter(row => !row.install && row.reason === null);
    const blocked = rows.filter(row => !row.install && row.reason !== null);
    const count = selected.size;

    const agentRow = ({agent, name}: {agent: AgentUser; name: string}, note: ReactNode, disabled: boolean) => (
        <ModalRow
            key={agent.agent_id}
            kind="agent"
            name={name}
            avatarUrl={agent.avatar?.url}
            note={note}
            disabled={disabled}
            onSelect={() => {
                setSelected(prev => {
                    const next = new Set(prev);
                    if (!next.delete(agent.agent_id)) next.add(agent.agent_id);
                    return next;
                });
            }}
        />
    );

    return (
        <>
            <ModalHeader
                title={`Add ${skill.display_name} to agents`}
                description="Pick the agents that should get this skill. Each one installs it on its next sync."
            >
                <ModalSearch value={query} onChange={setQuery} placeholder="Search agents"/>
            </ModalHeader>
            <ModalList>
                {agentsQuery.isPending || detailQuery.isPending ? (
                    <ModalNote>Loading…</ModalNote>
                ) : agentsQuery.isError || detailQuery.isError ? (
                    <p className="px-2.5 py-2 text-[13px] text-destructive">{errMsg(agentsQuery.error ?? detailQuery.error)}</p>
                ) : rows.length === 0 ? (
                    <ModalNote>{agents.length === 0 ? "No agents in this organization yet." : "No matches"}</ModalNote>
                ) : (
                    <>
                        {available.map(r => agentRow(
                            r,
                            <span className="inline-flex items-center gap-2">
                                {!r.agent.is_operator && r.agent.operator?.display_name}
                                {selected.has(r.agent.agent_id) && SELECTED}
                            </span>,
                            install.isPending,
                        ))}
                        {added.length > 0 && (
                            <ModalSection label="Already added">
                                {added.map(r => {
                                    const pill = installPill(r.install, versionsQuery.data?.versions);
                                    return agentRow(
                                        r,
                                        <span className="inline-flex items-center gap-2 tabular-nums">
                                            {r.install.installed_version && r.install.channel !== "pinned" && `v${r.install.installed_version}`}
                                            {pill && <TilePill {...pill}/>}
                                        </span>,
                                        true,
                                    );
                                })}
                            </ModalSection>
                        )}
                        {blocked.length > 0 && (
                            <ModalSection label="Not available">
                                {blocked.map(r => agentRow(r, r.reason, true))}
                            </ModalSection>
                        )}
                    </>
                )}
            </ModalList>
            <ModalFooter
                left={count > 0 && <span className="px-2.5 text-[12px] text-muted-foreground">{count} selected</span>}
            >
                <ModalButton onClick={onClose} disabled={install.isPending}>Cancel</ModalButton>
                <ModalButton
                    tone="primary"
                    disabled={count === 0 || install.isPending}
                    onClick={() => { install.mutate(); }}
                >
                    {install.isPending
                        ? "Adding…"
                        : count > 0 ? `Add to ${count} agent${count === 1 ? "" : "s"}` : "Add"}
                </ModalButton>
            </ModalFooter>
        </>
    );
}
