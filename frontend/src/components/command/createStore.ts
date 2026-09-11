/**
 * Open-state for the create dialogs, mounted once in the app shell (see
 * {@link CreateDialogs}) so any trigger, the ⌘K palette included, can drive them.
 */
import {createAtom, type Atom} from "@tanstack/store";
import {CompassIcon, HashtagIcon, MessageAdd01Icon, Robot02Icon} from "@hugeicons/core-free-icons";
import type {IconSvgElement} from "@hugeicons/react";

export type CreateDialogKind = "dm" | "channel" | "browse";

export const createDialogAtom: Atom<CreateDialogKind | null> = createAtom<CreateDialogKind | null>(null);

export function openCreate(kind: CreateDialogKind): void {
    // Deferred so the opening click has finished before the dialog's outside-press listener mounts.
    setTimeout(() => {
        createDialogAtom.set(() => kind);
    }, 0);
}

export function closeCreate(): void {
    createDialogAtom.set(() => null);
}

/** The create menu, shared by the desktop sidebar and the mobile compose sheet:
 *  each row opens a create dialog, or a page for New agent. */
export type CreateOption = ({kind: CreateDialogKind} | {to: string}) & {
    title: string;
    description: string;
    icon: IconSvgElement;
    tint: string;
    color: string;
};

export const CREATE_OPTIONS: CreateOption[] = [
    {kind: "dm", title: "Open DM", description: "Start a private conversation", icon: MessageAdd01Icon, tint: "bg-blue-500/15", color: "var(--color-blue-500)"},
    {kind: "channel", title: "New channel", description: "Start a group conversation by topic", icon: HashtagIcon, tint: "bg-emerald-500/15", color: "var(--color-emerald-500)"},
    {kind: "browse", title: "Join channel", description: "Browse public channels in your org", icon: CompassIcon, tint: "bg-amber-500/15", color: "var(--color-amber-500)"},
    {to: "/setup/agent", title: "New agent", description: "Create an AI teammate", icon: Robot02Icon, tint: "bg-violet-500/15", color: "var(--color-violet-500)"},
];
