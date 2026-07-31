/**
 * Step 4 — Launch: the wizard's finale. One centered column built around a
 * single big agent card: a HatchingCard (carrying the live status line ON it)
 * that flips into the real AgentCollectibleCard the moment the attributed
 * agent signs up. The reef one-time password sits above it; the "Say Hi"
 * action appears only once the agent is online.
 *
 * Attribution: the hero is the joined agent whose reef_sandbox_id matches the
 * created VM (linkReefVm is best-effort, so after ~30 s the first joined agent
 * is accepted instead); self-host takes first-joined. Other concurrent joins
 * render as compact rows — never as the hero.
 */
import {useEffect, useRef, useState} from "react";
import {
    BubbleChatIcon as BubbleChat,
    Alert02Icon as Alert,
    ArrowLeft01Icon as ArrowLeft,
    ComputerTerminal01Icon as Terminal,
    Copy01Icon as Copy,
    Tick01Icon as Check,
    KeyIcon as KeyGlyph,
} from "@hugeicons/core-free-icons";
import {Button} from "@/components/ui/button";
import {Icon} from "@/components/Icon";
import {AgentFaceAvatar} from "@/components/AgentFaceAvatar";
import {AgentCollectibleCard} from "@/components/agent-card/AgentCollectibleCard";
import {HatchingCard} from "@/components/agent-card/HatchingCard";
import {CardFlip} from "@/components/agent-card/CardFlip";
import {agentLivenessStatus} from "@/lib/agentLiveness";
import {cn} from "@/lib/utils";
import {burstEmojiFrom} from "@/lib/emojiBurst";
import {type AgentUser} from "@/lib/api";
import {AccessPasswordScreen} from "./bits";
import {agentLabel, type Mode} from "./useWizard";

export type PhaseState = "done" | "current" | "pending" | "error";

export interface TimelinePhase {
    label: string;
    state: PhaseState;
}

export function LaunchStep({
    mode,
    visible,
    phases,
    createError,
    onRetry,
    onBack,
    password,
    passwordPending,
    pwSaved,
    onPwSaved,
    pwCopied,
    onCopyPassword,
    hero,
    others,
    onSayHi,
    sayHiPendingId,
    codex,
}: {
    mode: Mode;
    /** False while the wizard is minimized (this subtree is display:none). */
    visible: boolean;
    phases: TimelinePhase[];
    createError: string | null;
    onRetry: () => void;
    onBack: () => void;
    password: string | null;
    /** The create call is still in flight, so a password may yet land. A missing
     *  password is indistinguishable from a pending one on the wire: both are
     *  null. This separates them, so the gate waits only while there's something
     *  to wait for. (All current reef runtimes mint one; Hermes' is the dashboard
     *  proxy's basic-auth secret, revealed only on the create response.) */
    passwordPending: boolean;
    /** Password gate passed — owned by the shell so the minimized session's
     *  dismiss guard can hang off it. */
    pwSaved: boolean;
    onPwSaved: () => void;
    pwCopied: boolean;
    onCopyPassword: () => void;
    hero: AgentUser | null;
    others: AgentUser[];
    onSayHi: (agentId: string) => void;
    sayHiPendingId: string | null;
    /** ChatGPT-subscription agents: the one-command, in-terminal device-code
     *  login handoff (auto-authed terminal URL + the command). null otherwise. */
    codex: {terminalOpenUrl: string; command: string} | null;
}) {
    const heroOnline = hero !== null && agentLivenessStatus(hero.last_alive_at ?? null) === "available";
    // The access password gets its own beat BEFORE the card: we show this screen
    // the instant we launch and the password streams in a moment later, so there's
    // no hatching-card flash first. (An errored create hands off to the card view's
    // Retry/Back; self-host has no password and skips this.)
    //
    // Gate on `passwordPending || password`, never on `password` alone: should a
    // create ever settle with no password (a future runtime without one) there is
    // nothing left to wait for, and waiting anyway strands the wizard on a
    // spinner with the Continue button disabled.
    const [connectSeen, setConnectSeen] = useState(false);
    const showPasswordGate =
        mode === "reef" && createError === null && !pwSaved && (passwordPending || password !== null);
    // ChatGPT-subscription agents get the connect handoff on its OWN screen, right
    // after the password gate — the OAuth login is the real "make it work" step, so
    // it isn't crammed under the hero card. `codex` is non-null by here: its
    // terminal URL + password ride the same create response the gate waited on.
    const showConnectScreen =
        !showPasswordGate && codex !== null && createError === null && !connectSeen;

    // Fire a one-shot 🎊 fountain from the card the instant the agent goes live —
    // reuses the reaction burst (canvas-confetti); no-ops under reduced-motion.
    // Held until the card is actually on screen (past the password gate) AND
    // the wizard is visible: minimized, the card measures 0×0 and the burst
    // would erupt at the viewport corner — it fires on restore instead.
    const cardRef = useRef<HTMLDivElement>(null);
    const celebratedRef = useRef(false);
    useEffect(() => {
        if (heroOnline && visible && !showPasswordGate && !showConnectScreen && !celebratedRef.current) {
            celebratedRef.current = true;
            burstEmojiFrom("🎊", cardRef.current);
        }
    }, [heroOnline, visible, showPasswordGate, showConnectScreen]);

    // The current phase drives the wizard button's waiting text (short, human
    // labels from the shell). The card just shows a constant "Hatching…". null
    // while the error block owns the view.
    const statusLabel = createError !== null
        ? undefined
        : (phases.find(p => p.state === "current")?.label ?? undefined);

    if (showPasswordGate) {
        return (
            <AccessPasswordScreen
                password={password}
                copied={pwCopied}
                onCopy={onCopyPassword}
                onContinue={onPwSaved}
            />
        );
    }

    if (showConnectScreen) {
        // `codex` is narrowed non-null here — showConnectScreen's definition
        // includes `codex !== null`.
        return (
            <CodexConnectScreen
                command={codex.command}
                terminalOpenUrl={codex.terminalOpenUrl}
                ready={heroOnline}
                onContinue={() => { setConnectSeen(true); }}
            />
        );
    }

    return (
        <div className="flex flex-col items-center gap-4">
            {/* The hero: one big, centered card, pulled up into its own top
                headroom. It hatches (status curved ON the card), then flips into
                the real agent card — which carries the identity (name, handle,
                joined, presence, Reef sticker) the moment the agent joins. */}
            <div ref={cardRef} className="-mt-5 w-full max-w-[360px]">
                <CardFlip
                    flipped={hero !== null}
                    front={<HatchingCard size="lg"/>}
                    back={
                        hero !== null ? (
                            <AgentCollectibleCard
                                seed={hero.agent_id}
                                name={agentLabel(hero)}
                                handle={hero.agent_id}
                                joined={hero.creation_time}
                                avatarUrl={hero.avatar?.url}
                                status={agentLivenessStatus(hero.last_alive_at ?? null)}
                                runsOnReef={mode === "reef"}
                                presentational
                                tilt
                                size="lg"
                            />
                        ) : (
                            // Placeholder face keeps the flip geometry before hydration.
                            <HatchingCard size="lg"/>
                        )
                    }
                />
            </div>

            {/* A failed reef create takes over with Retry / Back; otherwise the
                primary action lives here — always shown, big and full-width so
                it's the obvious next step. Same button throughout: a disabled
                "waiting" state until the agent is online, then the live "Say Hi".
                For ChatGPT-subscription agents, icon-only shortcuts to re-copy the
                access code + connect command sit BESIDE the CTA (no extra height —
                the guided connect itself is a separate screen before this one). */}
            {createError !== null ? (
                <div className="flex w-full max-w-[360px] animate-in flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3.5 fade-in duration-300">
                    <p className="flex items-start gap-2 text-[13px] font-medium text-destructive">
                        <Icon icon={Alert} className="mt-0.5 size-4 shrink-0"/>
                        <span className="min-w-0 break-words">{createError}</span>
                    </p>
                    <div className="flex gap-2">
                        <Button size="sm" onClick={onRetry}>Retry</Button>
                        <Button size="sm" variant="ghost" onClick={onBack} className="gap-1">
                            <Icon icon={ArrowLeft} className="size-3.5"/>
                            Back
                        </Button>
                    </div>
                </div>
            ) : (
                <Button
                    size="lg"
                    disabled={!heroOnline || sayHiPendingId !== null}
                    onClick={() => { if (hero) onSayHi(hero.agent_id); }}
                    className="mt-3 h-14 w-full max-w-[360px] gap-2 text-lg font-semibold"
                >
                    {heroOnline ? (
                        sayHiPendingId !== null ? (
                            "Saying hi…"
                        ) : (
                            <>Say Hi <span className="text-xl leading-none">👋</span></>
                        )
                    ) : (
                        <>
                            <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"/>
                            {statusLabel ?? "Getting your agent ready…"}
                        </>
                    )}
                </Button>
            )}

            {/* Access code (all reef agents) + Terminal command (ChatGPT-plan
                agents) — ghost buttons BELOW the CTA, sharing the row 50/50, or
                the access-code one full-width when it's alone. Whole-button click
                copies; the copy glyph sits at the right end. */}
            {mode === "reef" && password !== null && createError === null && (
                <div className="flex w-full max-w-[360px] gap-2 pb-2">
                    <GhostCopyButton icon={KeyGlyph} label="Access code" value={password} className="flex-1"/>
                    {codex !== null && (
                        <GhostCopyButton icon={Terminal} label="ChatGPT prompt" value={codex.command} className="flex-1"/>
                    )}
                </div>
            )}

            {/* Rare: concurrent joins that aren't THIS create's agent. */}
            {others.length > 0 && (
                <div className="flex w-full max-w-[360px] flex-col gap-1.5">
                    <p className="px-1 text-xs font-medium text-muted-foreground">Also just joined</p>
                    {others.map((a) => (
                        <CompactJoinedRow
                            key={a.agent_id}
                            agent={a}
                            pending={sayHiPendingId === a.agent_id}
                            onSayHi={onSayHi}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function CompactJoinedRow({
    agent,
    pending,
    onSayHi,
}: {agent: AgentUser; pending: boolean; onSayHi: (id: string) => void}) {
    const available = agentLivenessStatus(agent.last_alive_at ?? null) === "available";
    return (
        <div className="flex animate-in items-center gap-2.5 rounded-xl border border-border/50 bg-muted/30 px-3 py-2 fade-in slide-in-from-bottom-1 duration-300">
            <AgentFaceAvatar size={28} name={agentLabel(agent)} src={agent.avatar?.url}/>
            <span className="min-w-0 truncate text-sm font-medium">{agentLabel(agent)}</span>
            <span
                className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    available ? "bg-emerald-500" : "bg-blue-500 animate-pulse",
                )}
            />
            <Button
                size="sm"
                variant="ghost"
                disabled={!available || pending}
                onClick={() => { onSayHi(agent.agent_id); }}
                className="ml-auto h-7 gap-1.5 px-2.5 text-xs"
            >
                <Icon icon={BubbleChat} className="size-3.5"/>
                Say hi
            </Button>
        </div>
    );
}

/** ChatGPT-subscription (Codex OAuth) handoff — its own focused screen, mirroring
 *  the access-password beat. Open the agent's own web terminal (pre-authed), run
 *  the device-code login, approve in the browser. The login happens inside the
 *  agent's VM — the OAuth token never touches Clawbits/Reef. */
function CodexConnectScreen({
    command,
    terminalOpenUrl,
    ready,
    onContinue,
}: {
    command: string;
    terminalOpenUrl: string;
    /** Agent is online — its ttyd (web terminal) starts BEFORE the gateway, so
     *  "online" guarantees the terminal is serving. Gate "Open terminal" on it to
     *  avoid a 502 from opening the surface while the VM is still booting. */
    ready: boolean;
    onContinue: () => void;
}) {
    const [cmdCopied, setCmdCopied] = useState(false);
    const copyCmd = () => {
        void navigator.clipboard.writeText(command);
        setCmdCopied(true);
        window.setTimeout(() => { setCmdCopied(false); }, 1500);
    };
    return (
        <div className="flex w-full animate-in flex-col gap-4 py-1 fade-in duration-300">
            <div className="flex flex-col gap-4 px-3">
                <div className="flex flex-col gap-1 text-center">
                    <h3 className="text-xl font-semibold tracking-tight">Connect your ChatGPT plan</h3>
                    <p className="text-[13px] text-muted-foreground">Run this in your agent's terminal, then approve in your browser.</p>
                </div>

                {/* The agent's own web terminal this unlocks, shown clean — same
                    treatment as the access-password step's Control UI preview. */}
                <div className="w-full overflow-hidden rounded-2xl border border-border/50 bg-muted">
                    <img
                        src="/chatgpt-ui.webp"
                        alt=""
                        draggable={false}
                        className="aspect-[20/9] w-full select-none object-cover"
                    />
                </div>

                <div className="flex min-h-[68px] w-full items-center gap-2 rounded-2xl border border-border/70 bg-foreground/[0.03] px-5">
                    <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[15px] font-medium select-all">
                        {command}
                    </code>
                    <button
                        type="button"
                        onClick={copyCmd}
                        aria-label="Copy command"
                        className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                    >
                        <Icon icon={cmdCopied ? Check : Copy} className={cn("size-5", cmdCopied && "text-emerald-500")}/>
                    </button>
                </div>
            </div>

            <Button
                onClick={() => { window.open(terminalOpenUrl, "_blank", "noopener,noreferrer"); }}
                disabled={!ready}
                className="h-12 w-full gap-2 bg-emerald-600 text-white hover:bg-emerald-600/90 disabled:opacity-60"
            >
                {ready ? (
                    <>
                        <Icon icon={Terminal} className="size-4"/>
                        Open terminal
                    </>
                ) : (
                    <>
                        <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"/>
                        Waiting for your agent…
                    </>
                )}
            </Button>
            <Button onClick={onContinue} className="h-12 w-full text-base">
                Continue
            </Button>
        </div>
    );
}

/** A ghost button that copies `value` on click: a leading label icon, the label,
 *  and a copy glyph at the right end (which flips to a check). Used on the finale
 *  to re-grab the access code / connect command. */
function GhostCopyButton({
    icon,
    label,
    value,
    className,
}: {
    icon: React.ComponentProps<typeof Icon>["icon"];
    label: string;
    value: string | null;
    className?: string;
}) {
    const [copied, setCopied] = useState(false);
    const onClick = () => {
        if (!value) return;
        void navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => { setCopied(false); }, 1500);
    };
    return (
        <Button
            type="button"
            variant="ghost"
            onClick={onClick}
            disabled={!value}
            aria-label={`Copy ${label.toLowerCase()}`}
            className={cn(
                "h-10 min-w-0 justify-start gap-2 border border-border/50 bg-muted/40 px-3 hover:bg-muted/60",
                className,
            )}
        >
            <Icon icon={icon} className="size-4 shrink-0 text-muted-foreground"/>
            <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">{label}</span>
            <Icon
                icon={copied ? Check : Copy}
                className={cn("size-4 shrink-0", copied ? "text-emerald-500" : "text-muted-foreground")}
            />
        </Button>
    );
}
