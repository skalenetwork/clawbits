/**
 * The composer's agent-target chip: who the next message is addressed to.
 * A manual pick wins over the implicit auto-mention; both surface here so the
 * user can see and change the target before sending.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { Icon } from "@/components/Icon";
import { Cancel01Icon, Robot02Icon } from "@hugeicons/core-free-icons";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { MmChannelMember } from "@/lib/api";

function agentLabel(m: MmChannelMember): string {
  return m.display_name?.trim() || m.agent_id || "Agent";
}

export function AgentTargetChip({
  agents,
  manualHandle,
  autoMentionHandle,
  pulseKey,
  onPick,
  onClear,
}: {
  agents: (MmChannelMember & { agent_id: string })[];
  manualHandle: string | null;
  autoMentionHandle: string | null;
  pulseKey: string | null;
  onPick: (handle: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pulsing, setPulsing] = useState(false);
  const lastPulseKeyRef = useRef<string | null>(null);

  // Brief background flash when an auto-mention trigger first appears so the
  // user notices that the next send is now addressed to an agent.
  useEffect(() => {
    if (!pulseKey) return;
    if (pulseKey === lastPulseKeyRef.current) return;
    lastPulseKeyRef.current = pulseKey;
    setPulsing(true);
    const t = window.setTimeout(() => { setPulsing(false); }, 1400);
    return () => { window.clearTimeout(t); };
  }, [pulseKey]);

  const targetHandle = manualHandle ?? autoMentionHandle ?? null;
  const targetAgent = useMemo(
    () => (targetHandle ? agents.find((a) => a.agent_id === targetHandle) ?? null : null),
    [agents, targetHandle],
  );

  if (agents.length === 0) return null;

  const idle = targetAgent == null;
  const baseClass =
    "group flex h-7 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-full pl-1.5 pr-2 text-xs leading-none transition-colors";
  const stateClass = idle
    ? "border border-dashed border-border/60 px-2 text-muted-foreground hover:border-border hover:text-foreground"
    : "bg-mention/12 text-mention ring-1 ring-mention/25 hover:bg-mention/20";
  const pulseClass = pulsing && !idle ? "animate-target-pulse" : "";

  const seed = targetAgent
    ? (targetAgent.display_name ?? targetAgent.agent_id)
    : null;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        render={
          <button
            type="button"
            tabIndex={-1}
            aria-label={
              idle
                ? "Target an agent"
                : `Targeting @${targetAgent?.agent_id ?? ""} - click to change or clear`
            }
            className={`${baseClass} ${stateClass} ${pulseClass}`}
          >
            {targetAgent ? (
              <AgentFaceAvatar size={18} name={seed ?? ""} src={targetAgent.avatar?.url} framed={false}/>
            ) : (
              <Icon icon={Robot02Icon} className="size-4 shrink-0"/>
            )}
            <span className="truncate font-medium">
              {targetAgent ? `@${targetAgent.agent_id}` : "Agent"}
            </span>
            {!idle && (
              <span
                role="button"
                tabIndex={-1}
                aria-label="Clear target"
                onMouseDown={(e) => {
                  // mousedown so the parent popover doesn't toggle.
                  e.preventDefault();
                  e.stopPropagation();
                  onClear();
                }}
                className="-mr-1 flex size-4 items-center justify-center rounded-full text-mention/70 transition-colors hover:bg-mention/20 hover:text-mention"
              >
                <Icon icon={Cancel01Icon} className="size-2.5"/>
              </span>
            )}
          </button>
        }
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align="start"
          side="top"
          sideOffset={8}
          className="isolate z-50"
        >
          <PopoverPrimitive.Popup className="z-50 w-64 origin-(--transform-origin) overflow-hidden rounded-xl border border-border/60 bg-background/95 shadow-lg ring-1 ring-foreground/5 backdrop-blur-xl data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Target agent
              </span>
              <span className="text-[10px] tabular-nums text-muted-foreground/70">
                ⌘J
              </span>
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {agents.map((a) => {
                const active = a.agent_id === targetHandle;
                return (
                  <button
                    key={a.agent_id}
                    type="button"
                    onClick={() => {
                      onPick(a.agent_id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                      active
                        ? "bg-mention/10 text-foreground"
                        : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                    }`}
                  >
                    <AgentFaceAvatar
                      size={24}
                      name={a.display_name ?? a.agent_id}
                      src={a.avatar?.url}
                      framed={false}
                    />
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground">
                        {agentLabel(a)}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        @{a.agent_id}
                      </span>
                    </span>
                    {active && (
                      <span className="ml-2 size-1.5 shrink-0 rounded-full bg-mention"/>
                    )}
                  </button>
                );
              })}
            </div>
            {!idle && (
              <button
                type="button"
                onClick={() => {
                  onClear();
                  setOpen(false);
                }}
                className="flex w-full items-center justify-center gap-1.5 border-t border-border/40 px-3 py-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                <Icon icon={Cancel01Icon} className="size-3"/>
                Clear target
              </button>
            )}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// ----------------------------------------------------------------------------
// Keyboard cheatsheet — no longer a visible button on the action row (that
// row is kept to its load-bearing controls). Opened only via ⌘/, and anchored
// to the composer wrapper so it still positions correctly without a trigger.
// Markdown bold/italic stay on ⌘B / ⌘I (see ``handleKeyDown``); the other GFM
// formats are typed as literal markdown, which the renderer supports.
// ----------------------------------------------------------------------------
