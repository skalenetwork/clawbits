import {
    ModalButton,
    ModalFooter,
    ModalHeader,
    ModalPanel,
} from "@/components/modals/Modal";
import {DialogDescription} from "@/components/ui/dialog";
import type {Automation} from "@/lib/api";

export function DeleteAutomationDialog({automation, isPending, onOpenChange, onConfirm}: {
    automation: Automation | null;
    isPending: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
}) {
    return (
        <ModalPanel open={automation !== null} onOpenChange={onOpenChange} kind="confirm">
            <ModalHeader title="Remove automation"/>
            <DialogDescription className="px-4 pb-4 text-[13px]">
                Remove{" "}
                <span className="font-medium break-words text-foreground">
                    {automation?.name ?? "this automation"}
                </span>? The agent stops running it on its next reconcile. Past runs
                are cleared.
            </DialogDescription>
            <ModalFooter>
                <ModalButton onClick={() => { onOpenChange(false); }} disabled={isPending}>
                    Cancel
                </ModalButton>
                <ModalButton tone="destructive" onClick={onConfirm} disabled={isPending}>
                    {isPending ? "Removing…" : "Remove"}
                </ModalButton>
            </ModalFooter>
        </ModalPanel>
    );
}
