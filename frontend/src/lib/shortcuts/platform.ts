/**
 * Platform detection for shortcut keys.
 *
 * Returns the user-visible modifier glyph (⌘ on Mac, Ctrl elsewhere) and the
 * KeyboardEvent.key value the global listener watches for the hint-mode hold
 * trigger.
 */

export const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

export const modGlyph = isMac ? "⌘" : "Ctrl";

/** KeyboardEvent.key value emitted when the hint-mode trigger key is pressed. */
export const HOLD_KEY = isMac ? "Meta" : "Control";

/** Format a tinykeys-style binding for display, e.g. "$mod+b" → "⌘B". */
export function formatBinding(binding: string): string {
    return binding
        .split(" ")
        .map((seq) =>
            seq
                .split("+")
                .map((part) => {
                    if (part === "$mod") return modGlyph;
                    if (part === "Shift") return "⇧";
                    if (part === "Alt") return isMac ? "⌥" : "Alt";
                    if (part === "Control") return isMac ? "⌃" : "Ctrl";
                    if (part === "Meta") return "⌘";
                    return part.length === 1 ? part.toUpperCase() : part;
                })
                .join(""),
        )
        .join(" ");
}
