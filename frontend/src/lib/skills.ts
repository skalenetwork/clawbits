import type {Skill, SkillChannel, SkillManifest, SkillRuntime} from "@/lib/api";
import type {Pill} from "@/lib/status";

/** Up to two initials from the slug's segments, a short code where a skill has no emoji. */
export function skillMonogram(slug: string): string {
    return slug.split("-").map(part => part.charAt(0)).join("").slice(0, 2) || "?";
}

export function skillDetailPath(skill: Skill): string {
    return `/skills/${encodeURIComponent(skill.skill_id)}`;
}

const SYNC_PILLS: Record<string, Pill> = {
    requested: {label: "Installing…"},
    removing: {label: "Removing…"},
    failed: {label: "Failed", bad: true},
};

/** One install's pill, on the skill page or the agent tab; a healthy install has none. `versions` is the skill's
 *  history, newest first, so an install following latest can say how far it trails. */
export function installPill(
    install: {sync_status: string; channel?: SkillChannel; installed_version?: string | null; eligible?: boolean | null},
    versions: readonly {version: string}[] = [],
): Pill | null {
    const sync = SYNC_PILLS[install.sync_status];
    if (sync) return sync;
    if (install.eligible === false) return {label: "Not usable"};
    if (install.channel === "pinned" && install.installed_version) return {label: `Pinned to ${install.installed_version}`};
    const behind = versions.findIndex(v => v.version === install.installed_version);
    return behind > 0 ? {label: `${behind} behind`} : null;
}

/** A library tile's pill: a draft, or the most urgent of the server's install counts. */
export function skillPill({is_draft, attention: {failed, installing, removing, behind}}: Skill): Pill | null {
    if (is_draft) return {label: "Draft"};
    if (failed > 0) return {label: `${failed} failed`, bad: true};
    if (removing > 0) return {label: `${removing} removing…`};
    if (installing > 0) return {label: "Installing…"};
    return behind > 0 ? {label: `${behind} behind`} : null;
}

/** Display only; the server is the enforcement point. */
export const RUNTIME_LABELS: Record<SkillRuntime, string> = {
    openclaw: "OpenClaw",
    hermes: "Hermes",
    ironclaw: "IronClaw",
};

export const RUNTIME_CAN_RECEIVE: Record<SkillRuntime, boolean> = {
    openclaw: true,
    hermes: false,
    ironclaw: false,
};

/** Every dialect previews; only some can receive. */
export const RENDERABLE_RUNTIMES: SkillRuntime[] = ["openclaw", "hermes", "ironclaw"];

/** Mirrors render.resolve_runtime: no agent type yet, or an unknown one, is OpenClaw. */
export function agentRuntime(agentType: string | null | undefined): SkillRuntime {
    return RENDERABLE_RUNTIMES.find(rt => rt === agentType) ?? "openclaw";
}

/** Mirrored from spec.py for an instant hint; the server is authoritative. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const RESERVED_SLUG_PREFIX = "clawbits-";
export const DESCRIPTION_MAX = 160;

export function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
}

/** Why a slug can't be used, or null. */
export function slugProblem(slug: string): string | null {
    if (!slug) return "A name is required.";
    if (!SLUG_RE.test(slug)) return "Use lowercase letters, digits and hyphens only.";
    // Would shadow one of the clawbits-* skills baked into every image.
    if (slug.startsWith(RESERVED_SLUG_PREFIX)) return `Names starting with "${RESERVED_SLUG_PREFIX}" are reserved.`;
    return null;
}

/** The manifest we POST; the server normalizes it. Fields the form doesn't edit (requirements, env, invocation
 *  flags) are carried from `base`, so a publish never drops them. OpenClaw requires `name` to equal the folder. */
export function buildManifest({slug, description, emoji, base}: {
    slug: string;
    description: string;
    emoji: string;
    base?: SkillManifest;
}): SkillManifest {
    return {...base, name: slug, description: description.trim(), emoji: emoji.trim() || undefined};
}

interface DiffLine {
    kind: "same" | "add" | "del";
    text: string;
}
type DiffRow = DiffLine | {kind: "gap"; lines: number};

const DIFF_CELLS_MAX = 1_000_000;
const DIFF_CONTEXT = 2;

/** A line diff for reading: changed lines with a little context, longer unchanged runs folded into gaps. Longest
 *  common subsequence after trimming the shared head and tail; a middle too large for that reads as replaced. */
export function diffLines(before: string, after: string): DiffRow[] {
    const a = before.split("\n");
    const b = after.split("\n");
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a.at(-1 - tail) === b.at(-1 - tail)) tail++;
    const x = a.slice(head, a.length - tail);
    const y = b.slice(head, b.length - tail);

    const lines: DiffLine[] = a.slice(0, head).map(text => ({kind: "same", text}));
    if (x.length * y.length > DIFF_CELLS_MAX) {
        lines.push(...x.map(text => ({kind: "del" as const, text})), ...y.map(text => ({kind: "add" as const, text})));
    } else {
        const w = y.length + 1;
        const lcs = new Uint32Array((x.length + 1) * w);
        for (let i = x.length - 1; i >= 0; i--) {
            for (let j = y.length - 1; j >= 0; j--) {
                lcs[i * w + j] = x[i] === y[j]
                    ? lcs[(i + 1) * w + j + 1]! + 1
                    : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
            }
        }
        let i = 0;
        let j = 0;
        while (i < x.length || j < y.length) {
            if (i < x.length && j < y.length && x[i] === y[j]) {
                lines.push({kind: "same", text: x[i++]!});
                j++;
            } else if (j < y.length && (i === x.length || lcs[(i + 1) * w + j]! < lcs[i * w + j + 1]!)) {
                lines.push({kind: "add", text: y[j++]!});
            } else {
                lines.push({kind: "del", text: x[i++]!});
            }
        }
    }
    lines.push(...a.slice(a.length - tail).map(text => ({kind: "same" as const, text})));

    const rows: DiffRow[] = [];
    lines.forEach((line, n) => {
        const near = lines.slice(Math.max(0, n - DIFF_CONTEXT), n + DIFF_CONTEXT + 1).some(l => l.kind !== "same");
        const last = rows.at(-1);
        if (near) rows.push(line);
        else if (last?.kind === "gap") last.lines++;
        else rows.push({kind: "gap", lines: 1});
    });
    return rows;
}
