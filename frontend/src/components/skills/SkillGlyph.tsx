import {Squircle} from "@/components/home/tiles";
import type {Skill} from "@/lib/api";
import {skillMonogram} from "@/lib/skills";
import {cn} from "@/lib/utils";

/** A skill's mark wherever it appears: its emoji, or a monogram from the slug, on a flat muted squircle. The page
 *  mounts `SquircleDefs`. */
export function SkillGlyph({skill, size = 40, className}: {
    skill: Pick<Skill, "slug" | "icon_emoji">;
    size?: 16 | 20 | 40;
    className?: string;
}) {
    const emoji = skill.icon_emoji?.trim();
    return (
        <Squircle size={size} glass={false} className={cn("bg-muted text-muted-foreground", className)}>
            <span
                aria-hidden="true"
                className={cn("font-medium leading-none", !emoji && "tracking-tight")}
                style={{fontSize: size * (emoji ? 0.55 : 0.35)}}
            >
                {emoji || skillMonogram(skill.slug)}
            </span>
        </Squircle>
    );
}
