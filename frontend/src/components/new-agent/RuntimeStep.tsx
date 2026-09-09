/**
 * Step 1 — which runtime. Big cards (OpenClaw / IronClaw / Hermes); clicking one
 * IS the decision and advances.
 */
import type {ReactNode} from "react";
import type {Runtime} from "./useWizard";
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
    runtime,
    onPick,
}: {
    runtime: Runtime | null;
    onPick: (r: Runtime) => void;
}) {
    return (
        <div className="grid flex-1 grid-cols-1 content-start gap-3 sm:grid-cols-2">
            {RUNTIMES.map((r) => (
                <OptionCard
                    key={r.id}
                    icon={r.icon}
                    title={r.title}
                    line={r.line}
                    selected={runtime === r.id}
                    onSelect={() => { onPick(r.id); }}
                />
            ))}
        </div>
    );
}
