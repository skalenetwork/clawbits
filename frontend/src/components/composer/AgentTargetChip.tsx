import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Ban, Check, ChevronDown } from "lucide-react";

import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import type { MmChannelMember } from "@/lib/api";
import { MENU_ITEM, MENU_SURFACE } from "@/lib/menuSurface";
import { cn } from "@/lib/utils";

const ROW = cn(MENU_ITEM, "w-full text-left hover:bg-accent focus-visible:bg-accent");

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
  const target = agents.find((a) => a.agent_id === targetHandle);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(o, { reason }) => { onOpenChange(o, reason === "escape-key"); }}>
      <PopoverPrimitive.Trigger
        render={
          <button
            type="button"
            tabIndex={-1}
            aria-label={target ? `Sending to ${agentLabel(target)}` : "Send to an agent"}
            className={`flex h-7 min-w-0 max-w-48 items-center gap-1.5 rounded-full px-1.5 text-[13px] font-medium transition-colors hover:bg-foreground/6 data-popup-open:bg-foreground/6 ${target ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
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
            className={cn("z-50 max-h-72 w-64 origin-(--transform-origin) overflow-y-auto", MENU_SURFACE, "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95")}
          >
            <button type="button" onClick={() => { onPick(null); }} className={ROW}>
              <span className="grid size-5 shrink-0 place-items-center"><Ban/></span>
              No agent
              {!target && <Check className="ml-auto text-muted-foreground"/>}
            </button>
            {agents.map((a) => {
              const active = a.agent_id === targetHandle;
              return (
                <button key={a.agent_id} type="button" onClick={() => { onPick(active ? null : a.agent_id); }} className={ROW}>
                  <AgentFaceAvatar size={20} name={agentLabel(a)} src={a.avatar?.url} framed={false}/>
                  <span className="truncate">{agentLabel(a)}</span>
                  <span className="truncate text-xs text-muted-foreground">@{a.agent_id}</span>
                  {active && <Check className="ml-auto text-muted-foreground"/>}
                </button>
              );
            })}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
