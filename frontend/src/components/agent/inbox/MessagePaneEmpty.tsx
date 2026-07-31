/**
 * MessagePaneEmpty — the desktop reading pane before a message is selected.
 * Quiet, and it teaches the keyboard: the kbd chips are the discoverability
 * surface for j/k navigation.
 */
import type { ReactNode } from "react";
import { MailOpen01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      {children}
    </kbd>
  );
}

export function MessagePaneEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground">
        <Icon icon={MailOpen01Icon} className="size-5" />
      </div>
      <p className="text-sm font-medium text-foreground">Select a message</p>
      <p className="flex items-center gap-2 text-caption text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> navigate
        </span>
        <span aria-hidden>·</span>
        <span className="flex items-center gap-1">
          <Kbd>⏎</Kbd> open
        </span>
        <span aria-hidden>·</span>
        <span className="flex items-center gap-1">
          <Kbd>⌫</Kbd> delete
        </span>
      </p>
    </div>
  );
}
