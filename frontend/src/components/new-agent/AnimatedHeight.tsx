/**
 * AnimatedHeight — the wizard body sizes to each step's natural content and
 * ANIMATES between them (a ResizeObserver drives an explicit pixel height the
 * CSS transition can interpolate; `height: auto` can't animate). The dialog is
 * translate-centered, so a height change re-centers it symmetrically.
 * First paint applies the measured height without a transition (no grow-from-
 * zero on open); `prefers-reduced-motion` snaps.
 */
import {useEffect, useLayoutEffect, useRef, useState} from "react";
import {cn} from "@/lib/utils";

export function AnimatedHeight({children, className}: {children: React.ReactNode; className?: string}) {
    const innerRef = useRef<HTMLDivElement>(null);
    const [height, setHeight] = useState<number | null>(null);
    const [ready, setReady] = useState(false);
    // >0 while a descendant is running its own height-shaping transition (a
    // Section collapse animating grid-template-rows). Easing here on top of
    // that would compound into a laggy double-ease — the content finishes,
    // THEN the dialog catches up. Instead the wrapper follows each measured
    // frame instantly and the inner sweep is the one animation.
    const [innerSweeps, setInnerSweeps] = useState(0);

    useLayoutEffect(() => {
        const el = innerRef.current;
        if (!el) return;
        const measure = () => {
            // A minimized wizard keeps this mounted inside a display:none
            // popup, which measures 0 — hold the last real height so the
            // restore doesn't animate the body up from zero.
            const h = el.offsetHeight;
            if (h > 0) setHeight(h);
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        const sweeps = (e: TransitionEvent) => e.propertyName === "grid-template-rows";
        const sweepRun = (e: TransitionEvent) => {
            if (sweeps(e)) setInnerSweeps(n => n + 1);
        };
        const sweepDone = (e: TransitionEvent) => {
            if (sweeps(e)) setInnerSweeps(n => Math.max(0, n - 1));
        };
        el.addEventListener("transitionrun", sweepRun);
        el.addEventListener("transitionend", sweepDone);
        el.addEventListener("transitioncancel", sweepDone);
        return () => {
            ro.disconnect();
            el.removeEventListener("transitionrun", sweepRun);
            el.removeEventListener("transitionend", sweepDone);
            el.removeEventListener("transitioncancel", sweepDone);
        };
    }, []);

    // Arm the transition only after the first measured frame has painted.
    useEffect(() => {
        if (height === null || ready) return;
        const id = requestAnimationFrame(() => { setReady(true); });
        return () => { cancelAnimationFrame(id); };
    }, [height, ready]);

    return (
        <div
            className={cn(
                "overflow-hidden",
                ready && innerSweeps === 0 &&
                    "transition-[height] duration-300 ease-in-out motion-reduce:transition-none",
                className,
            )}
            style={{height: height ?? "auto"}}
        >
            <div ref={innerRef}>{children}</div>
        </div>
    );
}
