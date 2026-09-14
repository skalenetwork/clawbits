import {useEffect, useState} from "react";
import {createPortal} from "react-dom";
import {useSelector} from "@tanstack/react-store";
import {HINT_DATA_ATTR, shortcutsAtom} from "./store";
import {formatBinding} from "./platform";

const CHIP_GAP = 6;
const CHIP_WIDTH = 60;

interface Chip {
    id: string;
    label: string;
    binding: string;
    top: number;
    left: number;
    flip: boolean;
}

export function HintOverlay({visible}: {visible: boolean}) {
    return visible ? createPortal(<Chips/>, document.body) : null;
}

function Chips() {
    const shortcuts = useSelector(shortcutsAtom);
    const [chips, setChips] = useState<Chip[]>([]);

    useEffect(() => {
        const recompute = () => {
            setChips(Object.values(shortcuts).flatMap((spec): Chip[] => {
                if (!spec.hint) return [];
                // An off-canvas sidebar keeps its size at negative coordinates, so the anchor's center must be on screen.
                const rect = Array.from(document.querySelectorAll(`[${HINT_DATA_ATTR}="${spec.id}"]`), (el) => el.getBoundingClientRect())
                    .find((r) => {
                        const x = r.left + r.width / 2;
                        const y = r.top + r.height / 2;
                        return r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
                    });
                if (!rect) return [];
                const flip = rect.right + CHIP_GAP + CHIP_WIDTH > window.innerWidth;
                return [{
                    id: spec.id,
                    label: spec.hint.label,
                    binding: formatBinding(spec.keys),
                    top: rect.top + rect.height / 2,
                    left: flip ? rect.left - CHIP_GAP : rect.right + CHIP_GAP,
                    flip,
                }];
            }));
        };

        recompute();
        window.addEventListener("resize", recompute);
        window.addEventListener("scroll", recompute, true);
        return () => {
            window.removeEventListener("resize", recompute);
            window.removeEventListener("scroll", recompute, true);
        };
    }, [shortcuts]);

    return (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[100]">
            {chips.map((chip) => (
                <div
                    key={chip.id}
                    className="absolute flex items-center gap-1.5 rounded-md border border-foreground/15 bg-background/85 px-1.5 py-0.5 text-[11px] font-medium shadow-lg ring-1 ring-foreground/5 backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
                    style={{top: chip.top, left: chip.left, transform: chip.flip ? "translate(-100%, -50%)" : "translateY(-50%)"}}
                >
                    <kbd className="rounded bg-foreground px-1 py-0.5 text-[10px] font-semibold leading-none text-background">
                        {chip.label}
                    </kbd>
                    <span className="tabular-nums text-muted-foreground">{chip.binding}</span>
                </div>
            ))}
        </div>
    );
}
