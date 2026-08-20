import {useState} from "react";
import {Button} from "@/components/ui/button";

/** The work a dialog offers *before* the user commits to something
 *  irreversible — today, "save a copy of what's about to be destroyed". */
export interface ExtraAction {
    label: string;
    busyLabel?: string;
    doneLabel?: string;
    run: () => Promise<unknown>;
}

type ExtraState = "idle" | "busy" | "done";

/**
 * A button that runs an async side-task without settling the dialog it sits
 * in, and reports honestly how that task went.
 *
 * The one rule worth stating: a rejected ``run`` returns the button to its
 * original label and never advances to ``doneLabel``. These buttons sit next
 * to destructive confirms, so a button reading "Exported" over a download
 * that actually failed would talk someone into an irreversible delete on the
 * strength of a backup they don't have. Failure is expected to surface its
 * own message (a toast); this only has to avoid lying and stay retryable.
 *
 * ``resetKey`` returns the button to idle when the surrounding prompt is
 * replaced or reopened — otherwise a spent "Exported" would carry into the
 * next agent's or channel's dialog.
 */
export function ExtraActionButton({
    action,
    resetKey,
    disabled,
}: {
    action: ExtraAction;
    resetKey?: unknown;
    disabled?: boolean;
}) {
    const [state, setState] = useState<ExtraState>("idle");

    // Adjust-state-during-render rather than an effect, matching
    // DeleteAgentDialog's ``wasOpen`` reset: the fresh state is used on this
    // same render, so a reopened dialog never paints a stale "Exported" first.
    const [seenKey, setSeenKey] = useState(resetKey);
    if (resetKey !== seenKey) {
        setSeenKey(resetKey);
        setState("idle");
    }

    const run = () => {
        if (state !== "idle") return;
        setState("busy");
        void action.run().then(
            () => { setState("done"); },
            () => { setState("idle"); },
        );
    };

    const label =
        state === "busy" ? (action.busyLabel ?? "Working…")
        : state === "done" ? (action.doneLabel ?? "Done")
        : action.label;

    return (
        <Button
            type="button"
            variant="outline"
            disabled={disabled === true || state !== "idle"}
            onClick={run}
            className="sm:mr-auto"
        >
            {label}
        </Button>
    );
}
