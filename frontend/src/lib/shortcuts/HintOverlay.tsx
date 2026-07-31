import {useEffect, useState} from "react";
import {createPortal} from "react-dom";
import {useStore} from "@tanstack/react-store";
import {HINT_DATA_ATTR, shortcutsAtom} from "./store";
import {formatBinding} from "./platform";

interface ChipPosition {
    id: string;
    label: string;
    binding: string;
    /** Chip mid-Y in viewport px (chip is vertically centered on the anchor). */
    top: number;
    /**
     * Horizontal anchor edge in viewport px. When `side === "right"`, this is
     * the anchor's right edge and the chip is placed flush to its right. When
     * `side === "left"`, this is the anchor's left edge and the chip flips to
     * sit just left of the anchor — used near the viewport's right edge.
     */
    left: number;
    side: "right" | "left";
}

/** Gap between the chip and its anchor element in pixels. */
const CHIP_GAP = 6;
/** Approximate chip width — used to decide if we'd overflow the viewport. */
const CHIP_OVERFLOW_BUDGET = 60;

/**
 * Portal-rendered overlay shown while hint-mode is active. For each
 * registered shortcut with a hint, we look for a DOM element tagged with the
 * matching data attribute (set by <HintTarget>) and float a chip alongside
 * it. Shortcuts whose anchor isn't currently visible are skipped — chips
 * always sit next to a real on-screen target.
 */
export function HintOverlay({visible}: {visible: boolean}) {
    const shortcuts = useStore(shortcutsAtom, (s) => s);
    const [anchored, setAnchored] = useState<ChipPosition[]>([]);

    useEffect(() => {
        if (!visible) {
            setAnchored([]);
            return;
        }

        const recompute = () => {
            const next: ChipPosition[] = [];
            for (const spec of Object.values(shortcuts)) {
                if (!spec.hint) continue;
                const sel = `[${HINT_DATA_ATTR}="${spec.id}"]`;
                // Multiple anchors may share an id (e.g. mobile vs desktop
                // versions of the same toggle button). Pick the first one
                // that's actually laid out — skip zero-size / hidden ones.
                const candidates = document.querySelectorAll<HTMLElement>(sel);
                let visibleRect: DOMRect | null = null;
                for (const candidate of candidates) {
                    const rect = candidate.getBoundingClientRect();
                    // The shadcn sidebar collapses off-canvas via translate,
                    // so its inner buttons keep non-zero dimensions while
                    // sitting at negative coordinates with only a sliver in
                    // the viewport. Require the element's center to be on
                    // screen so we don't anchor to those slivers.
                    const hasSize = rect.width > 0 && rect.height > 0;
                    const centerX = rect.left + rect.width / 2;
                    const centerY = rect.top + rect.height / 2;
                    const centerInViewport =
                        centerX >= 0 &&
                        centerY >= 0 &&
                        centerX <= window.innerWidth &&
                        centerY <= window.innerHeight;
                    if (hasSize && centerInViewport) {
                        visibleRect = rect;
                        break;
                    }
                }
                if (!visibleRect) continue;

                const wouldOverflowRight =
                    visibleRect.right + CHIP_GAP + CHIP_OVERFLOW_BUDGET >
                    window.innerWidth;
                next.push({
                    id: spec.id,
                    label: spec.hint.label,
                    binding: formatBinding(spec.keys),
                    top: visibleRect.top + visibleRect.height / 2,
                    left: wouldOverflowRight
                        ? visibleRect.left - CHIP_GAP
                        : visibleRect.right + CHIP_GAP,
                    side: wouldOverflowRight ? "left" : "right",
                });
            }
            setAnchored(next);
        };

        recompute();
        window.addEventListener("resize", recompute);
        window.addEventListener("scroll", recompute, true);
        return () => {
            window.removeEventListener("resize", recompute);
            window.removeEventListener("scroll", recompute, true);
        };
    }, [visible, shortcuts]);

    if (!visible) return null;

    return createPortal(
        <div
            aria-hidden="true"
            className="pointer-events-none fixed inset-0 z-[100]"
        >
            {anchored.map((p) => (
                <Chip
                    key={p.id}
                    label={p.label}
                    binding={p.binding}
                    style={{
                        top: p.top,
                        left: p.left,
                        // Vertical: always center on the anchor.
                        // Horizontal: when placed to the right of the anchor,
                        // the chip's left edge is at `left` (no x-translate);
                        // when flipped to the left, translate by -100% so the
                        // chip's right edge sits at `left`.
                        transform:
                            p.side === "right"
                                ? "translateY(-50%)"
                                : "translate(-100%, -50%)",
                    }}
                />
            ))}
        </div>,
        document.body,
    );
}

function Chip({
    label,
    binding,
    style,
}: {
    label: string;
    binding: string;
    style: React.CSSProperties;
}) {
    return (
        <div
            // ``background-solid`` (not ``background``) so the chip stays a crisp
            // frosted surface regardless of the desktop window translucency —
            // plain ``--background`` carries ``--app-bg-opacity`` (~0.4 on dark
            // desktop), which washed these out. 85% + backdrop blur reads as
            // frosted glass over the rail rather than see-through.
            className="absolute flex items-center gap-1.5 rounded-md border border-foreground/15 bg-background-solid/85 px-1.5 py-0.5 text-[11px] font-medium shadow-lg ring-1 ring-foreground/5 backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
            style={style}
        >
            <kbd className="rounded bg-foreground px-1 py-0.5 text-[10px] font-semibold leading-none text-background-solid">
                {label}
            </kbd>
            <span className="tabular-nums text-muted-foreground">{binding}</span>
        </div>
    );
}
