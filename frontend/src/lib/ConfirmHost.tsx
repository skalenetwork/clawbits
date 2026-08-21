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
import {ExtraActionButton} from "@/components/ExtraActionButton";

/**
 * Renders the single confirmation dialog driven by the imperative
 * ``confirm()`` helper. Mount once at the app root. See ``confirm.ts``.
 */
export function ConfirmHost() {
    const [pending, setPending] = useState<PendingConfirm | null>(null);

    useEffect(() => registerConfirmEmitter(setPending), []);

    const settle = (ok: boolean) => {
        if (pending) pending.resolve(ok);
        setPending(null);
    };

    const destructive = pending?.destructive ?? true;
    const extra = pending?.extraAction;

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
                        // Keyed on the prompt so a second confirm() starts
                        // with a fresh button rather than a spent "Exported".
                        <ExtraActionButton action={extra} resetKey={pending}/>
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
