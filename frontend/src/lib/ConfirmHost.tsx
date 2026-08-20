import {useEffect, useState} from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {registerConfirmEmitter, type PendingConfirm} from "@/lib/confirm";

type ExtraState = "idle" | "busy" | "done";

/**
 * Renders the single confirmation dialog driven by the imperative
 * ``confirm()`` helper. Mount once at the app root. See ``confirm.ts``.
 */
export function ConfirmHost() {
    const [pending, setPending] = useState<PendingConfirm | null>(null);
    const [extraState, setExtraState] = useState<ExtraState>("idle");

    // Reset the extra action alongside the prompt it belongs to: a second
    // confirm() can replace the pending one outright, and a stale "done"
    // would render the new dialog's button already spent.
    useEffect(() => registerConfirmEmitter((next) => {
        setPending(next);
        setExtraState("idle");
    }), []);

    const settle = (ok: boolean) => {
        if (pending) pending.resolve(ok);
        setPending(null);
        setExtraState("idle");
    };

    const destructive = pending?.destructive ?? true;
    const extra = pending?.extraAction;

    const runExtra = () => {
        if (!extra || extraState !== "idle") return;
        setExtraState("busy");
        void extra.run().then(
            () => { setExtraState("done"); },
            () => { setExtraState("idle"); },
        );
    };

    const extraLabel =
        extraState === "busy" ? (extra?.busyLabel ?? "Working\u2026")
        : extraState === "done" ? (extra?.doneLabel ?? "Done")
        : extra?.label;

    return (
        <Dialog
            open={pending !== null}
            onOpenChange={(open) => { if (!open) settle(false); }}
        >
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{pending?.title}</DialogTitle>
                    {pending?.description && (
                        <DialogDescription>{pending.description}</DialogDescription>
                    )}
                </DialogHeader>
                <DialogFooter>
                    {extra && (
                        <Button
                            type="button"
                            variant="outline"
                            disabled={extraState !== "idle"}
                            onClick={runExtra}
                            className="sm:mr-auto"
                        >
                            {extraLabel}
                        </Button>
                    )}
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => { settle(false); }}
                    >
                        {pending?.cancelLabel ?? "Cancel"}
                    </Button>
                    <Button
                        type="button"
                        variant={destructive ? "destructive" : "default"}
                        onClick={() => { settle(true); }}
                    >
                        {pending?.confirmLabel ?? "Confirm"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
