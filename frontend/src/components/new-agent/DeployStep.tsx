/**
 * Step 1 — Where does this agent run? Two big option cards. Picking "Run on
 * Reef" without a verified session token expands the card in-place to the
 * admin-token field; the /providers probe doubles as verification (the shell
 * owns that query and auto-advances when it lands). "Self-hosted" advances
 * immediately. On a revisit, clicking a card re-selects and advances — there's
 * no separate Continue button.
 */
import {KeyIcon as Key} from "@hugeicons/core-free-icons";
import {Link} from "react-router-dom";
import type {Mode} from "./useWizard";
import {IconField, OptionCard} from "./bits";

export function DeployStep({
    mode,
    onPick,
    reefUrl,
    reefConnected,
    checkingReef,
    showTokenField,
    tokenValue,
    onTokenChange,
    tokenChecking,
    tokenRejected,
    reefUnreachable,
    onClose,
}: {
    mode: Mode | null;
    onPick: (mode: Mode) => void;
    reefUrl: string | null;
    reefConnected: boolean;
    checkingReef: boolean;
    showTokenField: boolean;
    tokenValue: string;
    onTokenChange: (v: string) => void;
    tokenChecking: boolean;
    tokenRejected: boolean;
    reefUnreachable: boolean;
    onClose: () => void;
}) {
    const reefPickable = Boolean(reefUrl) && (reefConnected || checkingReef);
    return (
        <div className="flex flex-1 flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <OptionCard
                    icon={<img src="/reef.svg" alt=""/>}
                    tile="linear-gradient(180deg, #FF8781, #FF5451)"
                    title="Reef"
                    line={
                        reefUrl ? (
                            "Spun up and managed for you"
                        ) : (
                            <span>
                                No Reef -{" "}
                                <Link
                                    to="/settings/reef"
                                    onClick={onClose}
                                    className="pointer-events-auto font-medium text-foreground underline underline-offset-2"
                                >
                                    connect one
                                </Link>
                            </span>
                        )
                    }
                    selected={mode === "reef"}
                    disabled={!reefPickable}
                    onSelect={() => { onPick("reef"); }}
                >
                    {mode === "reef" && showTokenField && (
                        <div className="flex animate-in flex-col gap-2 fade-in slide-in-from-top-1 duration-200">
                            <IconField
                                icon={Key}
                                type="password"
                                value={tokenValue}
                                onChange={(e) => { onTokenChange(e.target.value); }}
                                placeholder="Reef admin token"
                                autoFocus
                            />
                            {tokenChecking ? (
                                <p className="flex items-center gap-2 px-1 text-[13px] text-muted-foreground">
                                    <span className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-muted-foreground"/>
                                    Checking your Reef…
                                </p>
                            ) : tokenRejected ? (
                                <p className="px-1 text-[13px] font-medium text-destructive">
                                    Reef rejected this token - check it and try again.
                                </p>
                            ) : reefUnreachable ? (
                                <p className="px-1 text-[13px] font-medium text-destructive">
                                    Can't reach your Reef - is its tunnel up?
                                </p>
                            ) : (
                                <p className="px-1 text-[13px] text-muted-foreground">
                                    Paste your Reef admin token.
                                </p>
                            )}
                        </div>
                    )}
                </OptionCard>

                <OptionCard
                    icon={
                        // currentColor svg — masked so it renders white on the tile.
                        <span
                            aria-hidden="true"
                            className="size-8 bg-white [mask-image:url(/server4-filled.svg)] [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain]"
                        />
                    }
                    tile="linear-gradient(180deg, #818CF8, #4F46E5)"
                    title="Self-hosted"
                    line="Your machine, one pasted prompt"
                    selected={mode === "self"}
                    onSelect={() => { onPick("self"); }}
                />
            </div>
        </div>
    );
}
