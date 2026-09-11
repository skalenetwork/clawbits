import { memo, useMemo } from "react";

import { CODE_BODY, CodeFrame } from "@/components/CodeBlock";
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
      {/* The tail renders outside MessageMarkdown, so the blank-line gap comes from
          here; greedy wrapping keeps finished text from re-breaking mid-stream. */}
      {finished !== "" && (
        <MessageMarkdown content={finished} mentions={mentions} className="text-wrap [&+*]:mt-6" />
      )}
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
      <div className="text-message text-foreground">
        <p>
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
    <div className="text-message text-foreground break-words">
      <p className="whitespace-pre-wrap">
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
    <CodeFrame lang={lang}>
      <pre className={CODE_BODY}>
        <code>
          {code}
          <Caret />
        </code>
      </pre>
    </CodeFrame>
  );
}

/** Structured tail (list/heading/table/quote): hardened markdown + caret. */
function StructuredTail({ block }: { block: string }) {
  const hardened = useMemo(() => hardenIncompleteMarkdown(block), [block]);
  return (
    <div className="relative">
      {/* Pretty wrapping would hop words between lines as the block grows. */}
      <MessageMarkdown content={hardened} className="text-wrap" />
      <Caret />
    </div>
  );
}
