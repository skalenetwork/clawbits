/**
 * Session state for the Add Agent wizard's minimize-to-chip lifecycle.
 * Mirrors createStore's atom pattern (@tanstack/store).
 *
 * The wizard is a SESSION, not just a dialog: while phase !== "closed" the
 * WizardBody stays mounted (hidden via the dialog's keepMounted) so its
 * queries, the create mutation's results — including the one-time access
 * password that can never be re-shown — and the booting poll all survive a
 * visual close. "minimized" renders as the WizardDockChip at the bottom of
 * the sidebar; restoring reopens the dialog with everything intact.
 */
import {createAtom, type Atom} from "@tanstack/store";
import {currentViewport} from "@/lib/viewport";

/** Same read useIsMobile seeds from: the stamped ``html[data-viewport]`` is
 *  what the shell actually renders by, so trusting it (over a fresh
 *  innerWidth) keeps this decision consistent with whether the chip dock
 *  exists on screen at all. */
function isMobileViewport(): boolean {
    if (typeof document !== "undefined") {
        const v = document.documentElement.dataset.viewport;
        if (v === "mobile") return true;
        if (v === "desktop") return false;
    }
    return currentViewport() === "mobile";
}

export type WizardPhase = "closed" | "open" | "minimized";

export type WizardChipStatus = "draft" | "working" | "ready" | "error";

/** What the dock chip shows — published by WizardBody, read by WizardDockChip. */
export interface WizardChipSummary {
    title: string;
    subtitle: string;
    status: WizardChipStatus;
    /** Draft-phase completion (0..1) → the chip's tiny pie; null hides it. */
    progress: number | null;
}

/** Why dismissing the session must confirm first (null = dismiss freely):
 *  "creating" = the create call is in flight; "password" = the one-time
 *  access password exists but the owner hasn't taken it yet. */
export type WizardDismissGuard = null | "creating" | "password";

/** The confirm() copy for each guard — shared by every discard affordance
 *  (the chip's ✕, the dialog's ✕) so the warning reads the same everywhere. */
export const GUARD_COPY: Record<NonNullable<WizardDismissGuard>, {title: string; description: string}> = {
    creating: {
        title: "Discard while creating?",
        description:
            "Your agent is still being created. Its one-time access password will be lost — it can never be shown again.",
    },
    password: {
        title: "Discard the agent setup?",
        description:
            "The one-time access password hasn't been saved. It can never be shown again.",
    },
};

export interface WizardSessionState {
    phase: WizardPhase;
    /** Increments per FRESH session — keys WizardBody so restore ≠ remount. */
    sessionId: number;
    /** The org the session started under, pinned so an org switch while
     *  minimized can't re-target the signup token / queries mid-flight. */
    orgId: string | null;
    /** A meaningful choice was made — Esc/backdrop minimize instead of close. */
    dirty: boolean;
    guard: WizardDismissGuard;
    summary: WizardChipSummary | null;
}

const CLOSED: WizardSessionState = {
    phase: "closed",
    sessionId: 0,
    orgId: null,
    dirty: false,
    guard: null,
    summary: null,
};

export const wizardSessionAtom: Atom<WizardSessionState> =
    createAtom<WizardSessionState>(CLOSED);

// Dev-only escape hatch: lets E2E drivers observe the LIVE atom — an in-page
// dynamic import would get a second module instance under Vite and read lies.
if (import.meta.env.DEV && typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__wizardSessionAtom = wizardSessionAtom;
}

/** End the session and reset everything except the session counter. */
function closedState(s: WizardSessionState): WizardSessionState {
    return {...CLOSED, sessionId: s.sessionId};
}

/** Open a fresh session, or bring a minimized one back — never resets one. */
export function openOrRestoreWizard(): void {
    wizardSessionAtom.set((s) =>
        s.phase === "closed"
            ? {...CLOSED, phase: "open", sessionId: s.sessionId + 1}
            : {...s, phase: "open"},
    );
}

/** Hide the dialog but keep the session alive (the corner minimize button,
 *  Say Hi's navigate-away). */
export function minimizeWizard(): void {
    wizardSessionAtom.set((s) =>
        s.phase === "open" ? {...s, phase: "minimized"} : s,
    );
}

/**
 * The wizard's default close request (Esc / backdrop / another create dialog
 * preempting): a dirty session minimizes, a pristine one closes — no junk
 * chips. Mobile always closes: the mobile shell has no dock for the chip,
 * and an invisible live session would be worse than today's reset.
 */
export function minimizeOrCloseWizard(): void {
    wizardSessionAtom.set((s) => {
        if (s.phase !== "open") return s;
        if (s.dirty && !isMobileViewport()) return {...s, phase: "minimized"};
        return closedState(s);
    });
}

/** Fully end the session (chip ✕, in-wizard leave links, sign-out). */
export function closeWizard(): void {
    wizardSessionAtom.set(closedState);
}

/** Pin the session to the org it started under (once, at session start). */
export function pinWizardOrg(orgId: string): void {
    wizardSessionAtom.set((s) =>
        s.phase === "closed" || s.orgId !== null ? s : {...s, orgId},
    );
}

/** WizardBody publishes what the chip shows + how close/dismiss behave.
 *  Value-compared so the agents poll re-publishing an unchanged summary
 *  every 2.5s doesn't re-render every atom subscriber. */
export function publishWizardMeta(meta: {
    dirty: boolean;
    guard: WizardDismissGuard;
    summary: WizardChipSummary;
}): void {
    wizardSessionAtom.set((s) => {
        if (s.phase === "closed") return s;
        const same =
            s.dirty === meta.dirty &&
            s.guard === meta.guard &&
            s.summary !== null &&
            s.summary.title === meta.summary.title &&
            s.summary.subtitle === meta.summary.subtitle &&
            s.summary.status === meta.summary.status &&
            s.summary.progress === meta.summary.progress;
        return same ? s : {...s, ...meta};
    });
}
