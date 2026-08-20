import {useState} from "react";
import {Icon} from "@/components/Icon";
import {Delete02Icon as Trash} from "@hugeicons/core-free-icons";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Switch} from "@/components/ui/switch";
import {Label} from "@/components/ui/label";
import {ExtraActionButton, type ExtraAction} from "@/components/ExtraActionButton";

interface DeleteAgentDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Display name shown in bold in the prompt. */
    agentName: string;
    /** Delete in flight — disables the controls and swaps the button label. */
    isPending: boolean;
    /** Called with the operator's "keep messages" choice when they confirm. */
    onConfirm: (keepContent: boolean) => void;
    /** Optional "save the DM first" action. Null when the operator has no DM
     *  with this agent, in which case no export button is offered. */
    exportAction?: ExtraAction | null;
}

/**
 * Confirmation dialog for deleting an agent, shared by the agents list and the
 * agent profile so the wording and the "keep messages" choice stay identical.
 *
 * The toggle defaults to ON, so the safer outcome is the default: everything
 * the agent wrote is re-homed to a shared "Deleted agent" placeholder and
 * conversations survive for the other members who shared those channels.
 * Flipping it off opts into the full, irreversible delete.
 */
export function DeleteAgentDialog({
    open,
    onOpenChange,
    agentName,
    isPending,
    onConfirm,
    exportAction,
}: DeleteAgentDialogProps) {
    const [keepContent, setKeepContent] = useState(true);

    // Reset the toggle each time the dialog (re)opens so a prior choice doesn't
    // silently carry into the next agent's delete. Done during render via
    // React's "adjust state when a prop changes" pattern rather than an effect.
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) setKeepContent(true);
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => { if (!next && !isPending) onOpenChange(false); }}
        >
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        <Icon icon={Trash} className="text-destructive"/>
                        Delete agent?
                    </DialogTitle>
                    <DialogDescription>
                        <strong className="break-words">{agentName}</strong>{" "}
                        and its account, API key, and identity will be permanently
                        deleted. This can't be undone.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/30 p-3">
                    <Switch
                        id="keep-agent-content"
                        className="mt-0.5"
                        checked={keepContent}
                        onCheckedChange={setKeepContent}
                        disabled={isPending}
                    />
                    <div className="space-y-0.5">
                        <Label htmlFor="keep-agent-content" className="text-sm font-medium">
                            Keep its messages &amp; content
                        </Label>
                        <p className="text-xs text-muted-foreground">
                            {keepContent
                                ? "Its posts, files, and conversations stay, reattributed to “Deleted agent.”"
                                : exportAction
                                    ? "Its posts, files, and conversations will also be permanently deleted — export your chat first if you want to keep it."
                                    : "Its posts, files, and conversations will also be permanently deleted."}
                        </p>
                    </div>
                </div>

                <DialogFooter>
                    {exportAction && (
                        // Reset on reopen so a previous agent's "Exported"
                        // doesn't greet the next delete.
                        <ExtraActionButton
                            action={exportAction}
                            resetKey={open}
                            disabled={isPending}
                        />
                    )}
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => { onOpenChange(false); }}
                        disabled={isPending}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        variant="destructive"
                        onClick={() => { onConfirm(keepContent); }}
                        disabled={isPending}
                    >
                        {isPending ? "Deleting…" : "Delete agent"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
