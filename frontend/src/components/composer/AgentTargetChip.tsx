/**
 * Who the next message goes to: a quiet label in the composer toolbar that
 * opens a short agent list. A manual pick wins over the auto-mention.
 */
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Ban, Check, ChevronDown } from "lucide-react";

import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import type { MmChannelMember } from "@/lib/api";

const ROW = "flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] transition-colors hover:bg-foreground/6";

function agentLabel(m: MmChannelMember): string {
  return m.display_name?.trim() || m.agent_id || "Agent";
}

export function AgentTargetChip({
  agents,
  targetHandle,
  open,
  onOpenChange,
  onPick,
  align,
}: {
  agents: (MmChannelMember & { agent_id: string })[];
  targetHandle: string | null;
  open: boolean;
  onOpenChange: (open: boolean, refocus: boolean) => void;
  onPick: (handle: string | null) => void;
  align: "start" | "end";
}) {
  const target = agents.find((a) => a.agent_id === targetHandle) ?? null;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(o, { reason }) => { onOpenChange(o, reason === "escape-key"); }}>
      <PopoverPrimitive.Trigger
        render={
          <button
            type="button"
            tabIndex={-1}
            aria-label={target ? `Sending to ${agentLabel(target)}` : "Send to an agent"}
            className={`flex h-7 min-w-0 max-w-48 items-center gap-1.5 rounded-lg px-1.5 text-[13px] font-medium transition-colors hover:bg-foreground/6 data-popup-open:bg-foreground/6 ${target ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {target && <AgentFaceAvatar size={16} name={agentLabel(target)} src={target.avatar?.url} framed={false}/>}
            <span className="truncate">{target ? agentLabel(target) : "Agent"}</span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground"/>
          </button>
        }
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner align={align} side="top" sideOffset={8} className="isolate z-50">
          <PopoverPrimitive.Popup
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
                e.preventDefault();
                onOpenChange(false, true);
              }
            }}
            className="z-50 w-64 origin-(--transform-origin) rounded-xl border border-border/60 bg-popover p-1 shadow-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">Send to</div>
            <div className="max-h-64 overflow-y-auto">
              <button
                type="button"
                onClick={() => { onPick(null); }}
                className={`${ROW} text-muted-foreground hover:text-foreground`}
              >
                <span className="grid size-5 shrink-0 place-items-center rounded-md bg-foreground/6"><Ban className="size-3"/></span>
                <span className="font-medium">No agent</span>
                {!target && <Check className="ml-auto size-3.5 shrink-0"/>}
              </button>
              {agents.map((a) => {
                const active = a.agent_id === targetHandle;
                return (
                  <button
                    key={a.agent_id}
                    type="button"
                    onClick={() => { onPick(active ? null : a.agent_id); }}
                    className={ROW}
                  >
                    <AgentFaceAvatar size={20} name={agentLabel(a)} src={a.avatar?.url} framed={false}/>
                    <span className="truncate font-medium">{agentLabel(a)}</span>
                    <span className="truncate text-xs text-muted-foreground">@{a.agent_id}</span>
                    {active && <Check className="ml-auto size-3.5 shrink-0 text-muted-foreground"/>}
                  </button>
                );
              })}
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
