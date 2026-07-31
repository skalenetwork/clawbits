import {cn} from "@/lib/utils";

/**
 * The Reef mark (`public/reef-outline.svg`) as a themeable, currentColor icon.
 * The asset is a stroke outline, so we paint it through a CSS mask + `bg-current`
 * rather than an `<img>`: that way it inherits the surrounding text color
 * (hover / active nav states) and sizes like the hugeicons nav icons. Defaults
 * to `size-4`; pass `className` to override.
 */
export function ReefIcon({className}: {className?: string}) {
    return (
        <span
            aria-hidden="true"
            className={cn("inline-block size-4 shrink-0 bg-current", className)}
            style={{
                maskImage: "url(/reef-outline.svg)",
                WebkitMaskImage: "url(/reef-outline.svg)",
                maskRepeat: "no-repeat",
                WebkitMaskRepeat: "no-repeat",
                maskPosition: "center",
                WebkitMaskPosition: "center",
                maskSize: "contain",
                WebkitMaskSize: "contain",
            }}
        />
    );
}
