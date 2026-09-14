import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { initials, isPlatformAddress, senderAccent, senderName } from "./emailDisplay";

export function SenderMonogram({ from }: { from: string }) {
  const accent = senderAccent(from);
  return (
    <span
      aria-hidden
      className={cn("grid size-8 shrink-0 place-items-center rounded-full", accent.bg, accent.text)}
    >
      {isPlatformAddress(from) ? (
        <Bot className="size-4" />
      ) : (
        <span className="text-[11px] font-semibold">{initials(senderName(from))}</span>
      )}
    </span>
  );
}
