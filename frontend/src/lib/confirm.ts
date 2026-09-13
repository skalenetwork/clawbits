import type {ExtraAction} from "@/components/ExtraActionButton";

export interface ConfirmOptions {
    title: string;
    description?: string;
    confirmLabel?: string;
    /** Runs in place without settling the prompt, e.g. save a copy before an irreversible delete. */
    extraAction?: ExtraAction;
}

export interface PendingConfirm extends ConfirmOptions {
    resolve: (ok: boolean) => void;
}

let emit: ((pending: PendingConfirm) => void) | null = null;

export function registerConfirmEmitter(fn: (pending: PendingConfirm) => void): () => void {
    emit = fn;
    return () => {
        if (emit === fn) emit = null;
    };
}

/** Awaitable confirm rendered by the single root ConfirmHost; declines when no host is mounted. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise(resolve => {
        if (emit) emit({...options, resolve});
        else resolve(false);
    });
}
