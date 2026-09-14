import {createAtom, type Atom} from "@tanstack/store";

export const commandPaletteOpenAtom: Atom<boolean> = createAtom(false);

export function openCommandPalette(): void {
    // Deferred so the opening click has finished before the dialog's outside-press listener mounts.
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
