import { Trophy } from "lucide-react";
import { cn } from "@/lib/utils";

/** The chat's score over its finished games (`useScoreLine`) in one line beside a trophy, for Channel info. */
export function ChatScore({ line, className }: { line: string; className?: string }) {
  return (
    <p title={line} className={cn("flex min-w-0 items-center gap-2", className)}>
      <Trophy aria-hidden className="size-4 shrink-0" />
      <span className="sr-only">Games score: </span>
      <span className="min-w-0 truncate">{line}</span>
    </p>
  );
}
