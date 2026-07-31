/**
 * Global open-state for the command palette, decoupled from any one trigger
 * so the Cmd/Ctrl+K shortcut, the desktop sidebar button, and the mobile
 * top-bar button can all drive the single palette mounted in the app shell.
 * Mirrors the shortcuts store's atom pattern (@tanstack/store). See
 * docs/protocol/SEARCH_SPEC.md (Cmd+K is the unified entry point).
 */
import {createAtom, type Atom} from "@tanstack/store";

export const commandPaletteOpenAtom: Atom<boolean> = createAtom(false);

export function openCommandPalette(): void {
    // Defer to the next task so the click that opened the palette has fully
    // settled before Base UI's Dialog mounts. Otherwise the Dialog's
    // outside-press dismissal catches the opening pointerdown and closes it
    // immediately. (The Cmd+K path uses toggle and has no pointer event.)
    setTimeout(() => {
        commandPaletteOpenAtom.set(() => true);
    }, 0);
}

export function closeCommandPalette(): void {
    commandPaletteOpenAtom.set(() => false);
}

export function toggleCommandPalette(): void {
    commandPaletteOpenAtom.set((open) => !open);
}
