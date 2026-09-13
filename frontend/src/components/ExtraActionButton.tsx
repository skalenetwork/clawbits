import {useState} from "react";
import {ModalButton} from "@/components/modals/Modal";

/** Work a dialog offers before an irreversible confirm, e.g. saving a copy of what is about to be destroyed. */
export interface ExtraAction {
    label: string;
    busyLabel?: string;
    doneLabel?: string;
    run: () => Promise<unknown>;
}

/** Runs `action` without settling its dialog. A rejected `run` returns to the idle label, never `doneLabel`: a
 *  button reading "Exported" over a failed backup would talk someone into the delete beside it. `resetKey` returns it
 *  to idle when the prompt is replaced or reopened. */
export function ExtraActionButton({
    action,
    resetKey,
    disabled = false,
}: {
    action: ExtraAction;
    resetKey?: unknown;
    disabled?: boolean;
}) {
    const [state, setState] = useState<"idle" | "busy" | "done">("idle");
    const [seenKey, setSeenKey] = useState(resetKey);
    if (resetKey !== seenKey) {
        setSeenKey(resetKey);
        setState("idle");
    }

    const run = () => {
        setState("busy");
        void action.run().then(
            () => { setState("done"); },
            () => { setState("idle"); },
        );
    };

    return (
        <ModalButton disabled={disabled || state !== "idle"} onClick={run}>
            {state === "busy" ? (action.busyLabel ?? "Working…") : state === "done" ? (action.doneLabel ?? "Done") : action.label}
        </ModalButton>
    );
}
