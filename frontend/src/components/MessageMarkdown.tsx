import { Children, cloneElement, isValidElement, memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { cn } from "@/lib/utils";
import { classifyEmojiOnly, jumboEmojiClass } from "@/lib/emoji";
import { ChannelMentionLink } from "@/components/ChannelMentionLink";
import { CodeBlock } from "@/components/CodeBlock";
import { ProfileMenuTrigger } from "@/components/ProfileMenu";
import { mentionHandle } from "@/lib/messageHelpers";
import { isHereToken } from "@/lib/mentions";
import type { MmChannel, MmChannelMember } from "@/lib/api";

// Zero-width space. Placed on an otherwise-empty line so CommonMark's block
// parser no longer treats it as a *blank* line (which it would collapse) -
// it becomes a non-blank continuation line that `remark-breaks` turns into a
// `<br>`. Invisible, so the line reads as a genuine empty line.
const ZWSP = "\u200B";

/** Preserve the blank lines a user actually typed. CommonMark collapses any
 *  run of blank lines into a single paragraph break, so ``a\n\n\n\nb`` renders
 *  identically to ``a\n\nb`` and the empty rows vanish. We swap each blank line
 *  for a zero-width-space line outside fenced code blocks (code keeps its own
 *  blank lines verbatim - they're significant there). Leading/trailing blank
 *  lines are dropped so messages don't render with dangling gaps. */
function preserveBlankLines(src: string): string {
  const lines = src.replace(/^\n+/, "").replace(/\n+$/, "").split("\n");
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  return lines
    .map((line) => {
      const fence = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        const run = fence[1] ?? "";
        if (!inFence) {
          inFence = true;
          fenceChar = run.charAt(0);
          fenceLen = run.length;
        } else if (run.charAt(0) === fenceChar && run.length >= fenceLen) {
          inFence = false;
        }
        return line;
      }
      return !inFence && line.trim() === "" ? ZWSP : line;
    })
    .join("\n");
}

/** Extract a plain string out of the children react-markdown passes to
 *  the `<code>` component inside a `<pre>` block. Handles the common
 *  string + nested-element cases without recursing into HTML the user
 *  authored manually (skipHtml is set so this stays safe). */
function reactChildrenToString(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactChildrenToString).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return reactChildrenToString(props.children ?? "");
  }
  return "";
}

/**
 * Channel-member context for highlighting `@mentions`. Tokens are stored
 * lowercased without the leading `@`. Agent matches get a strong primary
 * chip; human matches get a muted chip; unrecognised `@words` get a soft
 * "looks like a mention" tint so the writer's intent is still visible.
 */
export interface MessageMentions {
  agentTokens: ReadonlySet<string>;
  humanTokens: ReadonlySet<string>;
  /** Optional: an extra agent token to highlight more loudly (the channel's
   *  resident agent). Use when the post mentions the agent the channel is
   *  about, so it pops harder than a regular agent reference. */
  primaryAgentToken?: string | null;
  /** Lookup so each rendered mention can be wrapped in a profile menu with
   *  the right member details. Keyed by lowercased token (matching the
   *  same normalisation ``MENTION_RE`` uses). Omit to skip the menu. */
  memberByToken?: ReadonlyMap<string, MmChannelMember>;
  /** Org context for the profile menu's "Send message" shortcut. */
  orgId?: string | null;
  /** Inserts ``@handle `` at the composer caret — wired from the channel
   *  so the menu's "Mention in this channel" action lands in the right
   *  composer regardless of where it was opened from. */
  onMentionInsert?: (handle: string) => void;
  /** Current viewer's human_id; the profile menu swaps its action row
   *  for self-clicks (Edit profile instead of Send message). */
  currentUserId?: number | null;
  /** Channel lookup for ``#channel`` references. Keyed by lowercased
   *  ``MmChannel.name``. Includes public channels in the org plus any
   *  private channels the viewer is a member of. */
  channelsByToken?: ReadonlyMap<string, MmChannel>;
  /** Channels the viewer is already a member of. Drives the click
   *  fork: members go straight to the channel; non-members are shown
   *  a join-and-navigate confirmation. */
  currentUserChannelIds?: ReadonlySet<string>;
}

// Combined ``@mention`` + ``#channel`` matcher. ``.`` is inside the
// character class so handles like ``john.doe`` and channel names like
// ``v2.0-rc`` highlight as one token. The ``#`` branch carries a
// lookbehind so URL fragments (``https://x.com/page#anchor``) don't
// get misread as channel mentions — the ``#`` must be preceded by
// start-of-string or whitespace/punctuation, not a URL-path character.
// ``@`` keeps its existing lax behaviour because ``@`` doesn't appear
// in URLs at the same frequency.
const TOKEN_RE = /@[A-Za-z0-9_.-]+|(?<![A-Za-z0-9_./-])#[A-Za-z0-9_.-]+/g;

function tokenizeMentions(text: string, mentions: MessageMentions): ReactNode[] {
  if (!text.includes("@") && !text.includes("#")) return [text];
  const out: ReactNode[] = [];
  let lastIdx = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  // Reset stateful regex per call.
  TOKEN_RE.lastIndex = 0;
  // Minimalist style: one soft-blue hue for every resolved mention or
  // channel link, sitting a tier below the saturated link colour.
  // ``text-mention`` is a theme token (see index.css ``--mention``).
  // Disambiguation lives in the tooltip / avatar / glyph.
  const resolvedClass = "font-medium text-mention";
  const unresolvedClass = "text-muted-foreground/90";

  while ((match = TOKEN_RE.exec(text)) !== null) {
    if (match.index > lastIdx) out.push(text.slice(lastIdx, match.index));
    const raw = match[0];

    if (raw.startsWith("#")) {
      const token = raw.slice(1).toLowerCase();
      const channel = mentions.channelsByToken?.get(token);
      if (channel) {
        // Resolved channel reference: render an interactive chip that
        // routes on click. Members get a router link; non-members get
        // a confirm dialog that joins-then-navigates.
        const isMember = mentions.currentUserChannelIds?.has(channel.channel_id) ?? false;
        out.push(
          <ChannelMentionLink
            key={`c${String(key++)}`}
            channel={channel}
            isMember={isMember}
            className={`${resolvedClass} cursor-pointer rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40`}
          />,
        );
      } else {
        // Unresolved: keep the writer's intent visible without claiming
        // it's a real channel. Same muted style as an unresolved ``@``.
        out.push(
          <span key={`c${String(key++)}`} className={unresolvedClass}>
            {raw}
          </span>,
        );
      }
      lastIdx = match.index + raw.length;
      continue;
    }

    // ``@mention`` branch — original behaviour.
    const token = raw.slice(1).toLowerCase();
    // ``@here`` — the channel-wide broadcast token. Not a member, so it gets
    // its own emphasised pill (no profile menu) and always reads as
    // resolved, signalling "this pings everyone here".
    if (isHereToken(token)) {
      out.push(
        <span
          key={`m${String(key++)}`}
          className="rounded bg-mention/10 px-0.5 font-semibold text-mention"
          title="Notifies everyone in this channel"
        >
          {raw}
        </span>,
      );
      lastIdx = match.index + raw.length;
      continue;
    }
    const isPrimaryAgent =
      mentions.primaryAgentToken && token === mentions.primaryAgentToken.toLowerCase();
    const isAgent = mentions.agentTokens.has(token);
    const isHuman = mentions.humanTokens.has(token);
    let className: string;
    let title: string | undefined;
    if (isPrimaryAgent) {
      className = resolvedClass;
      title = `@${token} — this channel's agent`;
    } else if (isAgent) {
      className = resolvedClass;
      title = `@${token} — agent`;
    } else if (isHuman) {
      className = resolvedClass;
      title = `@${token}`;
    } else {
      // Looks like a mention but doesn't match a known channel member.
      // Stay neutral — no soft blue so the writer can tell the token
      // didn't resolve.
      className = unresolvedClass;
      title = undefined;
    }
    const isResolved = Boolean(isPrimaryAgent || isAgent || isHuman);
    const member = isResolved ? mentions.memberByToken?.get(token) : undefined;
    // Canonicalise the displayed handle when we can resolve the writer
    // to a known member, so a body that contains ``@stanlee`` renders as
    // ``@Stan-Lee`` regardless of how the writer typed it. Storage is
    // untouched — the message body still contains the original text, so
    // search, copy, and edit keep showing what was written. ``raw`` is
    // still used for the regex's ``lastIdx`` bookkeeping below.
    const displayText = member ? `@${mentionHandle(member)}` : raw;
    out.push(
      member ? (
        <ProfileMenuTrigger
          key={`m${String(key++)}`}
          member={member}
          handleText={displayText}
          className={`${className} cursor-pointer rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40`}
          ariaLabel={`Open profile menu for ${displayText}`}
        >
          {displayText}
        </ProfileMenuTrigger>
      ) : (
        <span key={`m${String(key++)}`} className={className} title={title}>
          {displayText}
        </span>
      ),
    );
    lastIdx = match.index + raw.length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

/**
 * Walk a react-markdown subtree and rewrite string children through the
 * mention tokenizer. Stops at <code>/<pre> so `@foo` inside code stays
 * literal.
 */
function renderWithMentions(
  children: ReactNode,
  mentions: MessageMentions,
): ReactNode {
  return Children.map(children, (child, idx) => {
    if (typeof child === "string") {
      return <span key={`t${String(idx)}`}>{tokenizeMentions(child, mentions)}</span>;
    }
    if (Array.isArray(child)) return renderWithMentions(child, mentions);
    if (isValidElement(child)) {
      const elementType = (child as { type?: unknown }).type;
      // Don't transform inside code/pre — `@foo` there is literal.
      if (elementType === "code" || elementType === "pre") return child;
      const props = child.props as { children?: ReactNode };
      if (props?.children !== undefined) {
        return cloneElement(
          child,
          undefined,
          renderWithMentions(props.children, mentions),
        );
      }
    }
    return child;
  });
}

function buildComponents(mentions: MessageMentions | undefined): Components {
  const wrap = (node: ReactNode): ReactNode =>
    mentions ? renderWithMentions(node, mentions) : node;
  return {
    p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{wrap(children)}</p>,
    a: ({ children, href }) => (
      // iOS systemBlue — #007AFF (light) / #0A84FF (dark). Matches the
      // link color Apple uses across iMessage, Safari, and Mail.
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-[#007AFF] underline-offset-2 hover:underline break-words dark:text-[#0A84FF]"
      >
        {children}
      </a>
    ),
    code: ({ className, children }) => {
      const isBlock = /language-/.test(className ?? "");
      // Block-level <code> is wrapped in <pre> below — return as-is so
      // <pre> can extract the raw text and language for shiki.
      if (isBlock) return <code className={className}>{children}</code>;
      return (
        <code className="inline-code rounded bg-muted px-1 py-0.5 font-mono text-[0.875em] break-all">
          {children}
        </code>
      );
    },
    pre: ({ children }) => {
      // react-markdown passes the inner <code> element as children. Pull
      // the language off its className (``language-ts`` etc.) and the
      // raw source out of its children so shiki can highlight.
      let lang: string | null = null;
      let codeText = "";
      Children.forEach(children, (child) => {
        if (isValidElement(child)) {
          const props = child.props as { className?: string; children?: ReactNode };
          const match = /language-([\w-]+)/.exec(props.className ?? "");
          if (match) lang = match[1] ?? null;
          codeText = reactChildrenToString(props.children ?? "");
        }
      });
      // Strip a single trailing newline — remark always emits one and it
      // would show as an empty last line in the highlighted output.
      const trimmed = codeText.replace(/\n$/, "");
      return <CodeBlock code={trimmed} lang={lang} />;
    },
    ul: ({ children }) => <ul className="my-1 list-disc pl-5 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="my-1 list-decimal pl-5 space-y-0.5">{children}</ol>,
    li: ({ children }) => <li className="marker:text-muted-foreground">{wrap(children)}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
        {wrap(children)}
      </blockquote>
    ),
    h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-2xl font-semibold tracking-tight">{wrap(children)}</h1>,
    h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-xl font-semibold tracking-tight">{wrap(children)}</h2>,
    h3: ({ children }) => <h3 className="mt-2 mb-1 text-lg font-semibold">{wrap(children)}</h3>,
    h4: ({ children }) => <h4 className="mt-2 mb-1 text-base font-semibold">{wrap(children)}</h4>,
    h5: ({ children }) => <h5 className="mt-2 mb-1 text-[15px] font-semibold">{wrap(children)}</h5>,
    h6: ({ children }) => <h6 className="mt-2 mb-1 text-[15px] font-semibold text-muted-foreground">{wrap(children)}</h6>,
    hr: () => <hr className="my-3 border-border" />,
    table: ({ children }) => (
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse text-[0.9em]">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">{wrap(children)}</th>
    ),
    td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{wrap(children)}</td>,
  };
}

export const MessageMarkdown = memo(function MessageMarkdown({
  content,
  className,
  mentions,
}: {
  content: string;
  className?: string;
  mentions?: MessageMentions;
}) {
  // Telegram-style jumbo render when the body is *only* emojis. Skips the
  // markdown pipeline entirely — there's nothing for remark to parse, and
  // the size class wouldn't survive being scoped to a single <p> anyway.
  const emojiCount = useMemo(() => classifyEmojiOnly(content), [content]);

  // Memoise the components map so a stable mentions object doesn't rebuild
  // it (and thus react-markdown's internals) on every render.
  const components = useMemo(() => buildComponents(mentions), [mentions]);

  // Keep the blank lines the user typed (CommonMark would otherwise collapse
  // every run of them into one paragraph break). See `preserveBlankLines`.
  const prepared = useMemo(() => preserveBlankLines(content), [content]);

  if (emojiCount > 0) {
    return (
      <p
        className={cn(
          "my-1 first:mt-0 last:mb-0 text-foreground break-words",
          jumboEmojiClass(emojiCount),
          className,
        )}
      >
        {content.trim()}
      </p>
    );
  }

  return (
    <div className={cn("text-[15px] leading-relaxed text-foreground break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={components}
        skipHtml
      >
        {prepared}
      </ReactMarkdown>
    </div>
  );
});
