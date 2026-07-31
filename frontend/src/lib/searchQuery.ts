/**
 * Parse search-operator syntax out of a command-palette query and resolve it
 * to structured message-search filters. Names (`in:`, `from:`) are resolved to
 * ids against the already-loaded channel / member / agent lists, so the server
 * receives ids, not fuzzy names (see docs/protocol/SEARCH_SPEC.md §8).
 *
 * Supported: `from:<name>` `in:<channel>` `before:<date>` `after:<date>`
 * `has:link` `has:file`. Values may be quoted for names with spaces
 * (`from:"John Doe"`). Operators are stripped from the returned `text`, which
 * drives both the name tier and the message query.
 */
import type {AgentUser, MmChannel, OrgMember} from "@/lib/api";
import {formatChannelTitle} from "@/lib/formatting";
import {fuzzyScore} from "@/lib/fuzzy";

export interface SearchFilters {
    channelId?: string;
    fromHumanId?: number;
    fromAgentId?: string;
    before?: string; // YYYY-MM-DD
    after?: string;
    hasLink?: boolean;
    hasFile?: boolean;
}

export interface SearchChip {
    /** Stable-ish id for React keys. */
    id: string;
    /** Display text, e.g. "in design", "from Bob", "has link". */
    label: string;
    /** The exact raw substring this operator occupied — used to remove it. */
    token: string;
}

export interface ParsedQuery {
    /** Query with operators stripped. */
    text: string;
    filters: SearchFilters;
    chips: SearchChip[];
}

export interface SearchSources {
    channels: MmChannel[];
    members: OrgMember[];
    agents: AgentUser[];
}

// from:/in:/before:/after:/has: with a bare or quoted value, anchored to a word
// boundary so "log in:foo" matches but "ratio 3:4" never does.
const OPERATOR_RE = /(^|\s)(from|in|before|after|has):("([^"]*)"|\S+)/gi;
// Require at least a substring-grade match (prefix/substring/exact/initials)
// to resolve a name — avoids a stray subsequence hijacking the filter.
const RESOLVE_MIN = 500;
const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

export function hasActiveFilters(f: SearchFilters): boolean {
    return (
        Boolean(f.channelId) ||
        f.fromHumanId != null ||
        Boolean(f.fromAgentId) ||
        Boolean(f.before) ||
        Boolean(f.after) ||
        Boolean(f.hasLink) ||
        Boolean(f.hasFile)
    );
}

function resolveChannel(value: string, channels: MmChannel[]): MmChannel | null {
    const v = value.replace(/^#/, "");
    let best: {c: MmChannel; score: number} | null = null;
    for (const c of channels) {
        const title = formatChannelTitle(c.display_name ?? c.name, c.name);
        const score = Math.max(fuzzyScore(v, c.name), fuzzyScore(v, title));
        if (score >= RESOLVE_MIN && (!best || score > best.score)) best = {c, score};
    }
    return best?.c ?? null;
}

interface AuthorMatch {
    humanId?: number;
    agentId?: string;
    label: string;
}

function resolveAuthor(
    value: string,
    members: OrgMember[],
    agents: AgentUser[],
): AuthorMatch | null {
    const v = value.replace(/^@/, "");
    let human: {m: OrgMember; score: number} | null = null;
    for (const m of members) {
        const score = Math.max(fuzzyScore(v, m.display_name ?? ""), fuzzyScore(v, m.email));
        if (score >= RESOLVE_MIN && (!human || score > human.score)) human = {m, score};
    }
    let agent: {a: AgentUser; score: number} | null = null;
    for (const a of agents) {
        const score = Math.max(
            fuzzyScore(v, a.display_name ?? ""),
            fuzzyScore(v, a.nickname ?? ""),
            fuzzyScore(v, a.agent_id),
        );
        if (score >= RESOLVE_MIN && (!agent || score > agent.score)) agent = {a, score};
    }
    if (human && (!agent || human.score >= agent.score)) {
        return {humanId: human.m.human_id, label: human.m.display_name ?? human.m.email};
    }
    if (agent) {
        return {
            agentId: agent.a.agent_id,
            label: agent.a.display_name ?? agent.a.nickname ?? agent.a.agent_id,
        };
    }
    return null;
}

function normalizeDate(value: string): string | null {
    if (!DATE_RE.test(value)) return null;
    const parts = value.split("-");
    const y = parts[0] ?? "";
    const m = parts[1] ?? "01";
    const d = parts[2] ?? "01";
    return `${y}-${m}-${d}`;
}

export function parseSearchQuery(raw: string, sources: SearchSources): ParsedQuery {
    const filters: SearchFilters = {};
    const chips: SearchChip[] = [];
    let seq = 0;

    const text = raw.replace(
        OPERATOR_RE,
        (match: string, lead: string, opRaw: string, full: string, quoted?: string) => {
            const op = opRaw.toLowerCase();
            const value = (quoted ?? full).trim();
            if (!value) return lead;
            const token = match.trimStart();
            const chip = (label: string) => {
                chips.push({id: `${op}-${String(seq++)}`, label, token});
            };
            switch (op) {
                case "in": {
                    const c = resolveChannel(value, sources.channels);
                    if (!c) return lead;
                    filters.channelId = c.channel_id;
                    chip(`in ${formatChannelTitle(c.display_name ?? c.name, c.name)}`);
                    return lead;
                }
                case "from": {
                    const a = resolveAuthor(value, sources.members, sources.agents);
                    if (!a) return lead;
                    if (a.humanId != null) filters.fromHumanId = a.humanId;
                    if (a.agentId) filters.fromAgentId = a.agentId;
                    chip(`from ${a.label}`);
                    return lead;
                }
                case "before": {
                    const d = normalizeDate(value);
                    if (!d) return match;
                    filters.before = d;
                    chip(`before ${d}`);
                    return lead;
                }
                case "after": {
                    const d = normalizeDate(value);
                    if (!d) return match;
                    filters.after = d;
                    chip(`after ${d}`);
                    return lead;
                }
                case "has": {
                    const v = value.toLowerCase();
                    if (v === "link" || v === "links") {
                        filters.hasLink = true;
                        chip("has link");
                        return lead;
                    }
                    if (v === "file" || v === "files") {
                        filters.hasFile = true;
                        chip("has file");
                        return lead;
                    }
                    return match;
                }
                default:
                    return match;
            }
        },
    );

    return {text: text.replace(/\s+/g, " ").trim(), filters, chips};
}
