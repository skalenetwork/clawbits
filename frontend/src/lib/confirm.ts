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
