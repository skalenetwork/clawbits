/**
 * Global open-state for the create dialogs (new DM / channel / agent), decoupled
 * from any one trigger so the ⌘K palette actions (and any future caller) can drive
 * a single set of dialogs mounted once in the app shell — see {@link CreateDialogs}.
 * Mirrors paletteStore's atom pattern (@tanstack/store).
 */
import {createAtom, type Atom} from "@tanstack/store";
import {minimizeOrCloseWizard, openOrRestoreWizard} from "@/components/new-agent/wizardSessionStore";

export type CreateDialogKind = "dm" | "channel" | "agent" | "browse";

/** Holds the open PLAIN create dialog. "agent" never occupies it — the wizard
 *  is session-based (wizardSessionStore) so it can minimize instead of reset. */
export const createDialogAtom: Atom<CreateDialogKind | null> = createAtom<CreateDialogKind | null>(null);

export function openCreate(kind: CreateDialogKind): void {
    // Defer to the next task (like openCommandPalette) so the click that
    // triggered this has settled before Base UI's Dialog mounts — otherwise the
    // dialog's outside-press dismissal catches the opening pointerdown.
    setTimeout(() => {
        if (kind === "agent") {
            // Any plain create dialog yields; a minimized wizard session is
            // RESTORED (state intact), not restarted.
            createDialogAtom.set(() => null);
            openOrRestoreWizard();
        } else {
            // One modal at a time: an open wizard steps aside — dirty sessions
            // minimize to their chip instead of losing progress.
            minimizeOrCloseWizard();
            createDialogAtom.set(() => kind);
        }
    }, 0);
}

export function closeCreate(): void {
    createDialogAtom.set(() => null);
}
