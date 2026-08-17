import type {Skill} from "@/lib/api";
import {skillMonogram} from "@/lib/skills";
import {cn} from "@/lib/utils";

/**
 * A skill's identity mark: the emoji a human chose for it, on a flat neutral
 * chip.
 *
 * This replaces a tile that hashed the skill id into one of three saturated
 * accents. That colour carried no information — two skills both being violet
 * said nothing — and it shouted at 28px in a list. The fallback is a monogram
 * from the slug rather than a shared book icon, because every skill wearing the
 * same glyph is the same failure as every skill wearing a random colour.
 */
export type SkillGlyphSize = "sm" | "md" | "lg";

const BOX: Record<SkillGlyphSize, string> = {
    sm: "size-5 rounded-[6px]",
    md: "size-7 rounded-lg",
    lg: "size-11 rounded-xl",
};

const EMOJI: Record<SkillGlyphSize, string> = {
    sm: "text-[11px]",
    md: "text-base",
    lg: "text-2xl",
};

const MONOGRAM: Record<SkillGlyphSize, string> = {
    sm: "text-[9px]",
    md: "text-[11px]",
    lg: "text-sm",
};

export function SkillGlyph({
    skill,
    size = "md",
    className,
}: {
    skill: Pick<Skill, "slug" | "icon_emoji">;
    size?: SkillGlyphSize;
    className?: string;
}) {
    const emoji = skill.icon_emoji?.trim();
    return (
        <span
            aria-hidden="true"
            className={cn(
                "flex shrink-0 items-center justify-center bg-muted text-muted-foreground",
                BOX[size],
                className,
            )}
        >
            {emoji ? (
                <span className={cn("leading-none", EMOJI[size])}>{emoji}</span>
            ) : (
                <span className={cn("font-medium leading-none tracking-tight", MONOGRAM[size])}>
                    {skillMonogram(skill.slug)}
                </span>
            )}
        </span>
    );
}
