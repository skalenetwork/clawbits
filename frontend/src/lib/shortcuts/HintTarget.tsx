import {cloneElement, isValidElement, type ReactElement} from "react";
import {HINT_DATA_ATTR} from "./store";

interface HintTargetProps {
    /** Shortcut id this anchor corresponds to (matches ShortcutSpec.id). */
    id: string;
    /**
     * A single React element to mark as the anchor. We add a data attribute
     * to it (no ref required) — the overlay locates it via DOM query.
     */
    children: ReactElement<Record<string, unknown>>;
}

/**
 * Marks a single child element as the visual anchor for a shortcut's hint
 * chip. Implemented as an attribute spray so it works on any element type
 * (host elements, shadcn buttons, base-ui primitives) without depending on
 * ref forwarding.
 */
export function HintTarget({id, children}: HintTargetProps) {
    if (!isValidElement(children)) return children;
    return cloneElement(children, {[HINT_DATA_ATTR]: id});
}
