/**
 * Imperative confirmation dialog, mirroring the ergonomics of the toast
 * singleton: call ``confirm({...})`` from anywhere (event handlers, mutation
 * bodies) and ``await`` a boolean. A single ``<ConfirmHost/>`` (see
 * ``ConfirmHost.tsx``) mounted at the app root renders the actual dialog, so
 * callers that aren't components — like the channel-action hooks — can prompt
 * without threading dialog state through every surface that triggers the
 * action.
 */
export interface ConfirmOptions {
    title: string;
    /** Body copy. Plain string today; kept narrow so callers can't smuggle
     *  arbitrary nodes that the host would have to sanitise. */
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Styles the confirm button as destructive (red). Default true, since
     *  every current caller is a delete/leave. */
    destructive?: boolean;
    /** Optional third button that runs *without* settling the prompt.
     *
     *  For irreversible actions there is often something the user wants to do
     *  before deciding — save a copy of what is about to be destroyed. Folding
     *  that into the confirm button would force it on everyone; making it a
     *  separate dialog would make them cancel and start over. So this runs in
     *  place and leaves the choice open. The host disables the button while
     *  ``run`` is in flight and after it resolves; a rejection re-enables it
     *  (the action is expected to report its own failure) and never advances
     *  to ``doneLabel``, which would wrongly imply a copy was saved. */
    extraAction?: {
        label: string;
        busyLabel?: string;
        doneLabel?: string;
        run: () => Promise<unknown>;
    };
}

export interface PendingConfirm extends ConfirmOptions {
    resolve: (ok: boolean) => void;
}

let emit: ((pending: PendingConfirm) => void) | null = null;

/** Registers the host's setter. Returns an unsubscribe for cleanup. */
export function registerConfirmEmitter(
    fn: (pending: PendingConfirm) => void,
): () => void {
    emit = fn;
    return () => {
        if (emit === fn) emit = null;
    };
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        if (!emit) {
            // No host mounted — fail safe by treating it as a decline rather
            // than silently performing the destructive action.
            resolve(false);
            return;
        }
        emit({...options, resolve});
    });
}
