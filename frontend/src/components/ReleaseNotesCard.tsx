import { useState } from "react";
import { ArrowUpRight01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import { Scrim } from "@/components/ProgressiveBlur";
import { ReleaseNotesBody } from "@/components/release-notes/ReleaseNotesBody";
import { Button } from "@/components/ui/button";
import { CHANGELOG_URL } from "@/components/WordmarkLink";
import { useReleaseNotes } from "@/hooks/useReleaseNotes";
import { openExternal } from "@/lib/desktop";
import { LATEST_RELEASE } from "@/lib/releaseNotes";
import { cn } from "@/lib/utils";

/** Non-blocking "What's new" card pinned bottom-left: no backdrop, no focus trap, the app stays usable behind it. */
export function ReleaseNotesCard() {
  const { open, dismiss } = useReleaseNotes();
  const [scrolled, setScrolled] = useState(false);
  if (!open || !LATEST_RELEASE) return null;
  const { version, title, body, image } = LATEST_RELEASE;

  return (
    <aside
      aria-labelledby="release-notes-title"
      className="fixed inset-x-3 bottom-[calc(var(--safe-bottom)+0.75rem)] z-50 flex max-h-[calc(100dvh-1.5rem)] flex-col overflow-hidden rounded-2xl border border-foreground/10 bg-popover shadow-lg duration-300 animate-in fade-in-0 slide-in-from-bottom-2 md:right-auto md:bottom-2.5 md:left-2.5 md:w-96"
    >
      {image && (
        // object-right: the heroes are app captures whose subject sits right of an empty background.
        <img
          src={image}
          alt=""
          draggable={false}
          className="aspect-[2/1] w-full shrink-0 select-none object-cover object-right"
        />
      )}
      <button
        type="button"
        aria-label="Close"
        onClick={dismiss}
        className={cn(
          "absolute top-2.5 right-2.5 grid size-6 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
          image
            ? "bg-foreground/25 text-background backdrop-blur-sm hover:bg-foreground/40"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Icon icon={Cancel01Icon} className="size-3.5" />
      </button>

      <div
        onScroll={e => { setScrolled(e.currentTarget.scrollTop > 0); }}
        className="no-scrollbar max-h-72 min-h-0 overflow-y-auto overscroll-contain pb-14"
      >
        <div className="sticky top-0 z-10 px-4 pt-3.5 pr-10 pb-1.5">
          {scrolled && <Scrim color="popover" />}
          <p className="text-[13px] text-muted-foreground">What's new in v{version}</p>
          <h2 id="release-notes-title" className="text-[17px] leading-6 font-medium text-foreground">
            {title ?? `v${version}`}
          </h2>
        </div>
        <ReleaseNotesBody content={body} className="px-4 text-[13px]/relaxed" />
      </div>

      <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-between p-2.5">
        <Scrim color="popover" side="bottom" />
        <Button
          variant="ghost"
          size="compact"
          onClick={() => {
            dismiss();
            void openExternal(CHANGELOG_URL);
          }}
        >
          All updates
          <Icon icon={ArrowUpRight01Icon} />
        </Button>
        <Button size="compact" onClick={dismiss}>Got it</Button>
      </div>
    </aside>
  );
}
