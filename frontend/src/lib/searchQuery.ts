import type {AgentUser, MmChannel, MmSearchFilters, OrgMember} from "@/lib/api";
import {formatChannelTitle} from "@/lib/formatting";
import {fuzzyScoreAny} from "@/lib/fuzzy";

export interface ParsedQuery {
    text: string;
    filters: MmSearchFilters;
    chips: {label: string; token: string; unresolved?: boolean}[];
}

// Anchored to a word boundary so "log in:foo" matches but "ratio 3:4" never does.
const OPERATOR_RE = /(^|\s)(from|in|before|after|has):("([^"]*)"|\S+)/gi;
const BARE_TAIL_RE = /(^|\s)(from|in|before|after|has):\s*$/i;
// Substring-grade or better, so a stray subsequence never hijacks a filter.
const RESOLVE_MIN = 500;
const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

const channelLabel = (c: MmChannel) => formatChannelTitle(c.display_name ?? c.name, c.name);

function best<T>(value: string, items: T[], names: (item: T) => string[]): {item: T; score: number} | null {
    let top: {item: T; score: number} | null = null;
    for (const item of items) {
        const score = fuzzyScoreAny(value, names(item).map((n) => n.toLowerCase()));
        if (score >= RESOLVE_MIN && (!top || score > top.score)) top = {item, score};
    }
    return top;
}

function normalizeDate(value: string): string | null {
    if (!DATE_RE.test(value)) return null;
    const [y = "", m = "01", d = "01"] = value.split("-");
    return `${y}-${m}-${d}`;
}

export function parseSearchQuery(
    raw: string,
    sources: {channels: MmChannel[]; members: OrgMember[]; agents: AgentUser[]},
): ParsedQuery {
    const filters: MmSearchFilters = {};
    const chips: ParsedQuery["chips"] = [];
    const text = raw.replace(OPERATOR_RE, (match: string, lead: string, op: string, full: string, quoted?: string) => {
        const value = (quoted ?? full).trim();
        if (!value) return lead;
        const chip = (label: string, unresolved?: boolean) => {
            chips.push({label, token: match.trimStart(), unresolved});
            return lead;
        };
        const v = value.toLowerCase();
        const key = op.toLowerCase();
        switch (key) {
            case "in": {
                const channel = best(v.replace(/^#/, ""), sources.channels, (c) => [c.name, channelLabel(c)])?.item;
                if (!channel) return chip(`in: ${value}`, true);
                filters.channelId = channel.channel_id;
                return chip(`in ${channelLabel(channel)}`);
            }
            case "from": {
                const name = v.replace(/^@/, "");
                const human = best(name, sources.members, (m) => [m.display_name ?? "", m.email]);
                const agent = best(name, sources.agents, (a) => [a.display_name ?? "", a.nickname ?? "", a.agent_id]);
                if (human && (!agent || human.score >= agent.score)) {
                    filters.fromHumanId = human.item.human_id;
                    return chip(`from ${human.item.display_name ?? human.item.email}`);
                }
                if (!agent) return chip(`from: ${value}`, true);
                filters.fromAgentId = agent.item.agent_id;
                return chip(`from ${agent.item.display_name ?? agent.item.nickname ?? agent.item.agent_id}`);
            }
            case "before":
            case "after": {
                const date = normalizeDate(value);
                if (!date) return match;
                filters[key] = date;
                return chip(`${key} ${date}`);
            }
            case "has":
                if (/^links?$/.test(v)) {
                    filters.hasLink = true;
                    return chip("has link");
                }
                if (/^files?$/.test(v)) {
                    filters.hasFile = true;
                    return chip("has file");
                }
        }
        return match;
    });
    return {text: text.replace(BARE_TAIL_RE, "").replace(/\s+/g, " ").trim(), filters, chips};
}
