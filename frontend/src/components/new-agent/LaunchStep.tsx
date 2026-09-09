/**
 * Step 3 — Launch: the wizard's finale. One centered column built around a
 * single big agent card: a HatchingCard (carrying the live status line ON it)
 * that flips into the real AgentCollectibleCard the moment the agent signs up.
 * The "Say Hi" action appears only once it is online.
 *
 * The hero is the first agent to join while the wizard is open; other
 * concurrent joins render as compact rows — never as the hero.
 */
import {useEffect, useRef} from "react";
import {BubbleChatIcon as BubbleChat} from "@hugeicons/core-free-icons";
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
import {agentLabel} from "./useWizard";

export type PhaseState = "done" | "current" | "pending" | "error";

export interface TimelinePhase {
    label: string;
    state: PhaseState;
}

export function LaunchStep({
    visible,
    phases,
    hero,
    others,
    onSayHi,
    sayHiPendingId,
}: {
    /** False while the wizard is minimized (this subtree is display:none). */
    visible: boolean;
    phases: TimelinePhase[];
    hero: AgentUser | null;
    others: AgentUser[];
    onSayHi: (agentId: string) => void;
    sayHiPendingId: string | null;
}) {
    const heroOnline = hero !== null && agentLivenessStatus(hero.last_alive_at ?? null) === "available";
    // Fire a one-shot 🎊 fountain from the card the instant the agent goes live —
    // reuses the reaction burst (canvas-confetti); no-ops under reduced-motion.
    // Held until the card is actually on screen (past the password gate) AND
    // the wizard is visible: minimized, the card measures 0×0 and the burst
    // would erupt at the viewport corner — it fires on restore instead.
    const cardRef = useRef<HTMLDivElement>(null);
    const celebratedRef = useRef(false);
    useEffect(() => {
        if (heroOnline && visible && !celebratedRef.current) {
            celebratedRef.current = true;
            burstEmojiFrom("🎊", cardRef.current);
        }
    }, [heroOnline, visible]);

    // The current phase drives the wizard button's waiting text (short, human
    // labels from the shell). The card just shows a constant "Hatching…".
    const statusLabel = phases.find(p => p.state === "current")?.label ?? undefined;

    return (
        <div className="flex flex-col items-center gap-4">
            {/* The hero: one big, centered card, pulled up into its own top
                headroom. It hatches (status curved ON the card), then flips into
                the real agent card - which carries the identity (name, handle,
                joined, presence) the moment the agent joins. */}
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

            {/* The primary action - always shown, big and full-width so it's the
                obvious next step. Same button throughout: a disabled "waiting"
                state until the agent is online, then the live "Say Hi". */}
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
