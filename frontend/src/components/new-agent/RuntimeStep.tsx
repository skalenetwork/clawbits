/**
 * Step 2 — which runtime. Big cards (OpenClaw / IronClaw / Hermes); clicking one
 * IS the decision and advances. On the reef path an image-version select sits at
 * the selected card's foot (shown only when the Reef advertises its images) —
 * a post-hoc edit reachable again via the rail chip. A runtime with no image
 * built yet is disabled (build one from the Reef's Images panel).
 */
import type {ReactNode} from "react";
import type {ReefImage} from "@/lib/reefApi";
import type {Mode, Runtime} from "./useWizard";
import {MaskIcon, OptionCard} from "./bits";

/** OpenClaw and IronClaw ship colour brand rasters; the Hermes mark is a
 *  monochrome silhouette, so it renders through MaskIcon (an `<img>` would pin it
 *  to the file's own fill and lose it on a dark card). */
const RUNTIMES: {id: Runtime; title: string; line: string; icon: ReactNode}[] = [
    {
        id: "openclaw",
        title: "OpenClaw",
        line: "Node gateway · plugin ecosystem",
        icon: <img src="/openclaw.png" alt="" className="rounded-lg object-contain"/>,
    },
    {
        id: "ironclaw",
        title: "IronClaw",
        line: "Rust · WASM channels",
        icon: <img src="/ironclaw.webp" alt="" className="rounded-lg object-contain"/>,
    },
    {
        id: "hermes",
        title: "Hermes",
        line: "Python gateway · dashboard config",
        icon: <MaskIcon src="/hermes.svg" className="size-full text-foreground"/>,
    },
];

export function RuntimeStep({
    mode,
    runtime,
    onPick,
    images,
    imageTag,
    onImageTag,
}: {
    mode: Mode | null;
    runtime: Runtime | null;
    onPick: (r: Runtime) => void;
    /** All images the Reef advertises; null = unknown (older reef / self-host). */
    images: ReefImage[] | null;
    imageTag: string | null;
    onImageTag: (tag: string | null) => void;
}) {
    return (
        <div className="grid flex-1 grid-cols-1 content-start gap-3 sm:grid-cols-2">
            {RUNTIMES.map((r) => {
                const typeImages =
                    images?.filter(i => (i.agent_type ?? "openclaw") === r.id) ?? null;
                // Reef path with a known-empty image list ⇒ nothing to boot.
                const noImage = mode === "reef" && typeImages !== null && typeImages.length === 0;
                const selected = runtime === r.id;
                const activeTag = typeImages?.find(i => i.is_active)?.tag ?? typeImages?.[0]?.tag ?? null;
                return (
                    <OptionCard
                        key={r.id}
                        icon={r.icon}
                        title={r.title}
                        line={noImage ? "No image on this Reef yet" : r.line}
                        selected={selected}
                        disabled={noImage}
                        onSelect={() => { onPick(r.id); }}
                    >
                        {selected && mode === "reef" && typeImages !== null && typeImages.length > 0 && (
                            <select
                                value={imageTag ?? activeTag ?? ""}
                                onChange={(e) => {
                                    // Choosing the active default clears the pin.
                                    onImageTag(e.target.value === activeTag ? null : e.target.value);
                                }}
                                onClick={(e) => { e.stopPropagation(); }}
                                className="animate-in self-start rounded-lg border border-border/60 bg-background/40 px-3 py-1.5 text-[13px] fade-in duration-200"
                                aria-label="Image version"
                            >
                                {typeImages.map((img) => (
                                    <option key={img.tag} value={img.tag}>
                                        {img.tag}
                                        {img.reef_image_version ? ` · v${img.reef_image_version}` : ""}
                                        {img.is_active ? " · active" : ""}
                                    </option>
                                ))}
                            </select>
                        )}
                    </OptionCard>
                );
            })}
        </div>
    );
}
