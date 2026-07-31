/**
 * Registry of keyboard shortcuts.
 *
 * Actions register themselves via useShortcut(); the ShortcutProvider reads
 * this atom to build the tinykeys binding map and to render the hint
 * overlay. Hint chips locate their anchor element by querying the DOM for
 * `[data-shortcut-hint="<id>"]` — that attribute is sprayed onto the target
 * by <HintTarget>. Using a data attribute keeps us agnostic to whether the
 * target is a host element or a component that may or may not forward refs.
 */

import {createAtom, type Atom} from "@tanstack/store";

export const HINT_DATA_ATTR = "data-shortcut-hint";

export interface HintMeta {
    /** Single-character (or short) label rendered inside the chip. */
    label: string;
    /** Optional grouping for the future cheatsheet view. */
    group?: string;
    /** Optional description shown in the cheatsheet. */
    description?: string;
}

export interface ShortcutSpec {
    /** Stable identifier — also the lookup key used by <HintTarget>. */
    id: string;
    /** tinykeys binding string, e.g. "$mod+b". */
    keys: string;
    /** Action invoked when the binding matches. */
    run: (event: KeyboardEvent) => void;
    /** When set, the shortcut participates in hint-mode. */
    hint?: HintMeta;
    /**
     * Optional gate. Return false to suppress the shortcut for this event
     * (e.g. when focus is inside an editable element). Takes precedence over
     * ``allowInEditable``.
     */
    when?: (ctx: {inEditable: boolean; event: KeyboardEvent}) => boolean;
    /**
     * Fire even when focus is in an editable element (input / textarea /
     * contenteditable). Defaults to false so generic shortcuts stay dormant
     * while the user is typing; the command palette opts in so ⌘K works from
     * the message composer. Ignored when ``when`` is set (that decides).
     */
    allowInEditable?: boolean;
}

export const shortcutsAtom: Atom<Record<string, ShortcutSpec>> = createAtom<
    Record<string, ShortcutSpec>
>({});

export function registerShortcut(spec: ShortcutSpec): () => void {
    shortcutsAtom.set((s) => ({...s, [spec.id]: spec}));
    return () => {
        shortcutsAtom.set((s) => {
            const {[spec.id]: _removed, ...rest} = s;
            return rest;
        });
    };
}
