import { CODE_BODY, CodeFrame } from "@/components/CodeBlock";
import { MessageMarkdown } from "@/components/MessageMarkdown";
import {
  classifyTail,
  hardenIncompleteMarkdown,
  parseOpenFence,
  splitStreamBlocks,
} from "@/lib/streamingMarkdown";

export function StreamingMarkdown({ text }: { text: string }) {
  const blocks = splitStreamBlocks(text);
  const finished = blocks.slice(0, -1).join("\n\n");

  return (
    <>
      {/* Greedy wrapping until settle: pretty wrapping hops words between lines as the text grows. */}
      {finished !== "" && (
        <MessageMarkdown content={finished} className="text-wrap [&+*]:mt-6" />
      )}
      <TailBlock block={blocks.at(-1) ?? ""} />
    </>
  );
}

function Caret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-caret-blink rounded-sm bg-muted-foreground/70 align-middle"
    />
  );
}

function TailBlock({ block }: { block: string }) {
  if (block.trim() === "") {
    return (
      <div className="text-message text-foreground">
        <p>
          <Caret />
        </p>
      </div>
    );
  }
  const kind = classifyTail(block);
  if (kind === "code") {
    const { lang, code } = parseOpenFence(block);
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
  if (kind === "structured") {
    return (
      <div className="relative">
        <MessageMarkdown content={hardenIncompleteMarkdown(block)} className="text-wrap" />
        <Caret />
      </div>
    );
  }
  return (
    <div className="text-message text-foreground break-words">
      <p className="whitespace-pre-wrap">
        {block.match(/\s+|\S+/g)?.map((tok, i) => (
          <span key={i} className="stream-word-in">
            {tok}
          </span>
        ))}
        <Caret />
      </p>
    </div>
  );
}
