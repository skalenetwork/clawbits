import { useState } from "react";
import { cn } from "@/lib/utils";

export function PromptSection({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  return (
    <section>
      <h4 className="mb-2 text-xs font-medium text-muted-foreground">Prompt</h4>
      <p
        ref={(el) => {
          if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight);
        }}
        className={cn("text-[13.5px] leading-relaxed whitespace-pre-wrap wrap-anywhere", !expanded && "line-clamp-6")}
      >
        {prompt}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => {
            setExpanded(!expanded);
          }}
          className="mt-1.5 rounded text-[13px] font-medium outline-none hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </section>
  );
}
