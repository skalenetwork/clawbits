import {useState} from "react";
import {
    ModalButton,
    ModalFooter,
    ModalHeader,
    ModalPanel,
} from "@/components/modals/Modal";
import {DialogDescription} from "@/components/ui/dialog";
import {Switch} from "@/components/ui/switch";
import {Label} from "@/components/ui/label";
import {ExtraActionButton, type ExtraAction} from "@/components/ExtraActionButton";

export function DeleteAgentDialog({
    open,
    onOpenChange,
    agentName,
    isPending,
    onConfirm,
    exportAction,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    agentName: string;
    isPending: boolean;
    onConfirm: (keepContent: boolean) => void;
    exportAction?: ExtraAction | null;
}) {
    const [keepContent, setKeepContent] = useState(true);
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) setKeepContent(true);
    }

    return (
        <ModalPanel
            open={open}
            onOpenChange={next => { if (!next && !isPending) onOpenChange(false); }}
            kind="confirm"
        >
            <ModalHeader title="Delete agent?"/>
            <div className="px-4 pb-4">
                <DialogDescription className="text-[13px]">
                    <span className="font-medium break-words text-foreground">{agentName}</span>{" "}
                    and its account, API key, and identity will be permanently
                    deleted. This can't be undone.
                </DialogDescription>
                <div className="mt-4 flex items-start gap-2.5">
                    <Switch
                        id="keep-agent-content"
                        size="sm"
                        className="mt-px"
                        checked={keepContent}
                        onCheckedChange={setKeepContent}
                        disabled={isPending}
                    />
                    <div className="min-w-0">
                        <Label htmlFor="keep-agent-content" className="text-[13px]">
                            Keep its messages &amp; content
                        </Label>
                        <p className="mt-1 text-[12px] text-muted-foreground">
                            {keepContent
                                ? "Its posts, files, and conversations stay, reattributed to “Deleted agent.”"
                                : `Its posts, files, and conversations will also be permanently deleted.${exportAction ? " Export your chat first if you want to keep it." : ""}`}
                        </p>
                    </div>
                </div>
            </div>
            <ModalFooter
                left={exportAction && (
                    <ExtraActionButton action={exportAction} resetKey={open} disabled={isPending}/>
                )}
            >
                <ModalButton onClick={() => { onOpenChange(false); }} disabled={isPending}>
                    Cancel
                </ModalButton>
                <ModalButton
                    tone="destructive"
                    onClick={() => { onConfirm(keepContent); }}
                    disabled={isPending}
                >
                    {isPending ? "Deleting…" : "Delete agent"}
                </ModalButton>
            </ModalFooter>
        </ModalPanel>
    );
}
