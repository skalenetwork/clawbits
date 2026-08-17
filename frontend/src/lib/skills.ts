import type {Skill, SkillManifest, SkillRuntime} from "@/lib/api";

/** Shared helpers for the skills library UI. */

/* A skill's visual identity is its emoji (or the monogram below) on a neutral
 * chip — see components/skills/SkillGlyph. The id used to be hashed into one of
 * three saturated tile colours; that colour meant nothing, so it was noise that
 * shouted. */

/** Up to two initials from the slug's segments, kept lowercase — it reads as a
 *  short code rather than a shouted label. */
export function skillMonogram(slug: string): string {
    const initials = slug
        .split("-")
        .filter(Boolean)
        .map(part => part[0])
        .join("");
    return (initials.slice(0, 2) || "?").toLowerCase();
}

export function skillDetailPath(skill: Skill): string {
    return `/skills/${encodeURIComponent(skill.skill_id)}`;
}

/** Display only — the server is the enforcement point. */
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

/** We can preview every dialect; only some can receive. */
export const RENDERABLE_RUNTIMES: SkillRuntime[] = ["openclaw", "hermes", "ironclaw"];

/** Mirrored from spec.py for an instant hint; the server is authoritative. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const RESERVED_SLUG_PREFIX = "clawbits-";
export const DESCRIPTION_MAX = 160;

/** Derive a legal slug from a display name. */
export function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
}

/** Client-side slug check. Returns a reason, or null when acceptable. */
export function slugProblem(slug: string): string | null {
    if (!slug) return "A name is required.";
    if (!SLUG_RE.test(slug)) {
        return "Use lowercase letters, digits and hyphens only.";
    }
    if (slug.startsWith(RESERVED_SLUG_PREFIX)) {
        // Would shadow one of the clawbits-* skills baked into every image.
        return `Names starting with "${RESERVED_SLUG_PREFIX}" are reserved.`;
    }
    return null;
}

/** Build the manifest we POST; the server normalizes and neutralizes it. */
export function buildManifest(input: {
    slug: string;
    description: string;
    emoji?: string;
    runtimes?: SkillRuntime[];
}): SkillManifest {
    const manifest: SkillManifest = {
        // OpenClaw requires frontmatter `name` == the directory name.
        name: input.slug,
        description: input.description.trim(),
    };
    if (input.emoji?.trim()) manifest.emoji = input.emoji.trim();
    if (input.runtimes?.length) manifest.runtimes = input.runtimes;
    return manifest;
}

/** Short, human label for where a skill came from. */
export function originLabel(skill: Skill): string | null {
    if (skill.origin === "forked") return "Forked";
    if (skill.origin === "imported") return "Imported";
    return null;
}


export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${String(bytes)} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}
