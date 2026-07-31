import { memo, useMemo } from "react";

import { MessageMarkdown, type MessageMentions } from "@/components/MessageMarkdown";
import {
  classifyTail,
  hardenIncompleteMarkdown,
  parseOpenFence,
  splitStreamBlocks,
} from "@/lib/streamingMarkdown";

/**
 * Markdown renderer for a *streaming* draft. The published path uses
 * {@link MessageMarkdown} directly; this component exists only for the live,
 * growing body and does three things a plain re-render can't:
 *
 *  1. **Block memoization.** The text is split into blank-line-delimited blocks
 *     (fences kept whole). Everything above the actively-growing tail is a
 *     stable prefix, rendered through the memoized {@link MessageMarkdown} once
 *     and re-parsed only when a *new* block completes — not on every frame.
 *     Turns the old O(n²) full re-parse per token into O(n)+O(tail).
 *  2. **A caret that rides the text.** The caret is the last inline child of
 *     the tail (true end-of-text), not a block sibling that drops onto its own
 *     line below the reply.
 *  3. **Expressive reveal.** A plain-prose tail streams word-by-word with a
 *     blur-in ({@link stream-word-in}); a growing code fence renders as a plain
 *     `<pre>` (shiki is deferred until the fence closes and the block settles),
 *     avoiding per-frame re-highlight; structured tails (lists/headings/tables)
 *     render as incomplete-markdown-hardened markdown so partial syntax doesn't
 *     flash literal asterisks then reflow.
 */
export function StreamingMarkdown({
  text,
  mentions,
}: {
  text: string;
  mentions?: MessageMentions;
}) {
  const blocks = useMemo(() => splitStreamBlocks(text), [text]);
  const tail = blocks[blocks.length - 1] ?? "";
  // Finished = every block above the tail, rejoined. Re-parsed only when a
  // block boundary is crossed (seconds apart), never per frame.
  const finished = useMemo(() => blocks.slice(0, -1).join("\n\n"), [blocks]);

  return (
    <>
      {finished !== "" && <MessageMarkdown content={finished} mentions={mentions} />}
      <TailBlock block={tail} />
    </>
  );
}

/** A blinking caret pinned inline at the end of the streamed text. */
function Caret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-caret-blink rounded-sm bg-muted-foreground/70 align-middle"
    />
  );
}

/** Render the actively-growing final block. */
function TailBlock({ block }: { block: string }) {
  if (block.trim() === "") {
    // Momentary state: text ends exactly on a block boundary. Keep the caret
    // alive so the row never looks stalled.
    return (
      <div className="text-[15px] leading-relaxed text-foreground">
        <p className="my-1">
          <Caret />
        </p>
      </div>
    );
  }
  const kind = classifyTail(block);
  if (kind === "code") return <CodeTail block={block} />;
  if (kind === "prose") return <ProseTail text={block} />;
  return <StructuredTail block={block} />;
}

/**
 * Plain-prose tail: each word in its own index-keyed span so React mounts a
 * fresh (animating) span only for genuinely new words, while the currently
 * forming word grows in place. Whitespace is preserved as its own tokens so
 * wrapping and spacing match a finished paragraph exactly. Mentions/inline
 * markdown are intentionally not tokenized here — they light up the instant
 * the block settles into {@link MessageMarkdown}.
 */
const ProseTail = memo(function ProseTail({ text }: { text: string }) {
  const tokens = useMemo(() => text.match(/\s+|\S+/g) ?? [], [text]);
  return (
    <div className="text-[15px] leading-relaxed text-foreground break-words">
      <p className="my-1 whitespace-pre-wrap">
        {tokens.map((tok, i) => (
          <span key={i} className="stream-word-in">
            {tok}
          </span>
        ))}
        <Caret />
      </p>
    </div>
  );
});

/** Growing code fence: plain `<pre>` with reserved chrome; shiki deferred. */
function CodeTail({ block }: { block: string }) {
  const { lang, code } = useMemo(() => parseOpenFence(block), [block]);
  return (
    <div className="code-block relative my-2 overflow-hidden rounded-md border border-border bg-muted/30">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 bg-muted/40 px-3 py-1">
        <span className="font-mono text-[11px] capitalize tracking-wide text-muted-foreground/80">
          {lang ?? "text"}
        </span>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[0.875em] leading-relaxed whitespace-pre">
        <code>
          {code}
          <Caret />
        </code>
      </pre>
    </div>
  );
}

/** Structured tail (list/heading/table/quote): hardened markdown + caret. */
function StructuredTail({ block }: { block: string }) {
  const hardened = useMemo(() => hardenIncompleteMarkdown(block), [block]);
  return (
    <div className="relative">
      <MessageMarkdown content={hardened} />
      <Caret />
    </div>
  );
}
