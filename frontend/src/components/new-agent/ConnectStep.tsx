/**
 * Step 3 (self-host path) — the copy-paste onboarding prompt for the picked
 * runtime. Copy advances to the Launch step (which keeps the prompt reachable
 * behind a disclosure while waiting).
 */
import {Copy01Icon as Copy, Tick01Icon as Check} from "@hugeicons/core-free-icons";
import {Button} from "@/components/ui/button";
import {Icon} from "@/components/Icon";
import type {Runtime} from "./useWizard";

/** Where the operator pastes the prompt — each runtime's own front door. */
const RUNTIME_TARGET: Record<Runtime, string> = {
    openclaw: "OpenClaw agent",
    ironclaw: "IronClaw WebUI",
    hermes: "Hermes shell",
};

export function ConnectStep({
    runtime,
    prompt,
    ready,
    copied,
    onCopy,
}: {
    runtime: Runtime;
    prompt: string;
    ready: boolean;
    copied: boolean;
    onCopy: () => void;
}) {
    return (
        <div className="flex flex-1 flex-col gap-3">
            <p className="text-center text-lg font-semibold">
                Send this to your {RUNTIME_TARGET[runtime]}
            </p>
            <pre className="max-h-[15rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-background/40 px-4 py-3.5 font-mono text-[12.5px] leading-relaxed">
                {prompt}
            </pre>
            <div className="mt-auto">
                <Button
                    type="button"
                    onClick={onCopy}
                    disabled={!ready}
                    className="h-12 w-full gap-2 text-base font-medium"
                >
                    <Icon icon={copied ? Check : Copy} className="size-4"/>
                    {copied ? "Copied" : "Copy prompt and continue"}
                </Button>
            </div>
        </div>
    );
}
