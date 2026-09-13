import {useEffect, useState} from "react";
import {
    ModalButton,
    ModalFooter,
    ModalHeader,
    ModalPanel,
} from "@/components/modals/Modal";
import {DialogDescription} from "@/components/ui/dialog";
import {registerConfirmEmitter, type PendingConfirm} from "@/lib/confirm";
import {ExtraActionButton} from "@/components/ExtraActionButton";

export function ConfirmHost() {
    const [pending, setPending] = useState<PendingConfirm | null>(null);

    useEffect(() => registerConfirmEmitter(setPending), []);

    const settle = (ok: boolean) => {
        pending?.resolve(ok);
        setPending(null);
    };

    return (
        <ModalPanel
            open={pending !== null}
            onOpenChange={open => { if (!open) settle(false); }}
            kind="confirm"
        >
            <ModalHeader title={pending?.title}/>
            {pending?.description && (
                <DialogDescription className="px-4 pb-4 text-[13px]">
                    {pending.description}
                </DialogDescription>
            )}
            <ModalFooter
                left={pending?.extraAction && (
                    <ExtraActionButton action={pending.extraAction} resetKey={pending}/>
                )}
            >
                <ModalButton onClick={() => { settle(false); }}>Cancel</ModalButton>
                <ModalButton tone="destructive" onClick={() => { settle(true); }}>
                    {pending?.confirmLabel ?? "Confirm"}
                </ModalButton>
            </ModalFooter>
        </ModalPanel>
    );
}
