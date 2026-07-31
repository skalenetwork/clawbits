import {Delete02Icon as Trash} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {Button} from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import type {Automation} from "@/lib/api";

/** Confirm-remove for a managed automation. Removal is itself asynchronous —
 *  the copy says so instead of pretending the row dies instantly. */
export function DeleteAutomationDialog({automation, isPending, onOpenChange, onConfirm}: {
    automation: Automation | null;
    isPending: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
}) {
    return (
        <Dialog open={automation !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        <Icon icon={Trash} className="text-destructive"/>
                        Remove automation
                    </DialogTitle>
                    <DialogDescription>
                        Remove <strong>{automation?.name ?? "this automation"}</strong>? The
                        agent stops running it on its next reconcile. Past runs are cleared.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter className="mt-4">
                    <Button type="button" variant="ghost" onClick={() => { onOpenChange(false); }} disabled={isPending}>
                        Cancel
                    </Button>
                    <Button type="button" variant="destructive" onClick={onConfirm} disabled={isPending}>
                        {isPending ? "Removing…" : "Remove"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
