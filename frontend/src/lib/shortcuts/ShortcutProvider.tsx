import {useEffect, useRef, useState, type ReactNode} from "react";
import {useSelector} from "@tanstack/react-store";
import {tinykeys} from "tinykeys";
import {shortcutsAtom} from "./store";
import {HOLD_KEY} from "./platform";
import {HintOverlay} from "./HintOverlay";

const HOLD_DELAY_MS = 450;

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (target.isContentEditable) return true;
    return false;
}

/**
 * Mounts the global keyboard listener and the hint overlay. Sits near the
 * top of the React tree (inside any router/provider that the shortcuts may
 * want to consult). One instance per app.
 *
 * Two responsibilities:
 *   1. Bind all registered shortcuts via tinykeys, rebuilding on registry change.
 *   2. Detect press-and-hold of the platform modifier (⌘/Ctrl) and surface
 *      the hint overlay after HOLD_DELAY_MS. While the overlay is open, a
 *      matching letter press fires the corresponding shortcut and dismisses.
 */
export function ShortcutProvider({children}: {children: ReactNode}) {
    const shortcuts = useSelector(shortcutsAtom);
    const [hintVisible, setHintVisible] = useState(false);
    const holdTimer = useRef<number | null>(null);
    const otherKeyPressed = useRef(false);

    const cancelHoldTimer = () => {
        if (holdTimer.current !== null) {
            window.clearTimeout(holdTimer.current);
            holdTimer.current = null;
        }
    };

    // Bind shortcuts via tinykeys. Re-bound whenever the registry changes.
    useEffect(() => {
        const map: Record<string, (event: KeyboardEvent) => void> = {};
        for (const spec of Object.values(shortcuts)) {
            map[spec.keys] = (event) => {
                const inEditable = isEditableTarget(event.target);
                if (spec.when) {
                    // Explicit gate decides (receives inEditable).
                    if (!spec.when({inEditable, event})) return;
                } else if (inEditable && !spec.allowInEditable) {
                    // Default: generic shortcuts stay dormant while typing.
                    return;
                }
                event.preventDefault();
                spec.run(event);
                // Pressing a shortcut while hint-mode is open should dismiss.
                setHintVisible(false);
                cancelHoldTimer();
            };
        }
        // tinykeys' default ``ignore`` skips EVERY editable target, which would
        // preempt the per-shortcut gating above and block ⌘K from the message
        // composer. Override it to only drop key-repeat / IME composition; the
        // editable decision is made per shortcut (via ``when`` /
        // ``allowInEditable``).
        return tinykeys(window, map, {
            ignore: (event) => event.repeat || event.isComposing,
        });
    }, [shortcuts]);

    // Hint-mode: hold the mod key (with no other key) for HOLD_DELAY_MS.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.repeat) return;
            if (e.key === HOLD_KEY) {
                // Holding the mod key only — start the timer if we're not in
                // an editable element (avoid surprising users mid-typing).
                if (isEditableTarget(e.target)) return;
                otherKeyPressed.current = false;
                cancelHoldTimer();
                holdTimer.current = window.setTimeout(() => {
                    if (!otherKeyPressed.current) setHintVisible(true);
                }, HOLD_DELAY_MS);
                return;
            }

            // Any non-mod key while the mod is down → user is doing a
            // chord, not a hold. Abort.
            if (e.metaKey || e.ctrlKey) {
                otherKeyPressed.current = true;
                cancelHoldTimer();
            }

            // Escape always dismisses.
            if (hintVisible && e.key === "Escape") {
                setHintVisible(false);
                cancelHoldTimer();
            }
        };

        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key === HOLD_KEY) {
                cancelHoldTimer();
                if (hintVisible) setHintVisible(false);
            }
        };

        const onBlur = () => {
            cancelHoldTimer();
            setHintVisible(false);
        };

        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("keyup", onKeyUp);
            window.removeEventListener("blur", onBlur);
            cancelHoldTimer();
        };
    }, [hintVisible]);

    return (
        <>
            {children}
            <HintOverlay visible={hintVisible} />
        </>
    );
}
