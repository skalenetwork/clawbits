import { Children, cloneElement, createContext, isValidElement, memo, use, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { cn } from "@/lib/utils";
import { classifyEmojiOnly, jumboEmojiClass } from "@/lib/emoji";
import { ChannelMentionLink } from "@/components/ChannelMentionLink";
import { CodeBlock } from "@/components/CodeBlock";
import { MENTION_TOKEN_RE, MentionsContext, type MessageMentions } from "@/components/mentionsContext";
import { ProfileMenuTrigger } from "@/components/ProfileMenu";
import { mentionHandle } from "@/lib/messageHelpers";
import { isHereToken } from "@/lib/mentions";
import { claimMcpSignIn, isMcpSignInLink } from "@/lib/api";
import { errMsg, toast } from "@/lib/toast";
import { isDesktop, openExternal } from "@/lib/desktop";

// A zero-width-space line is non-blank to CommonMark, so remark-breaks keeps it as an empty line.
const ZWSP = "​";

function startsGfmTable(row?: string, delimiter = ""): boolean {
  const d = delimiter.trim();
  return !!row?.includes("|") && d.includes("|") && d.includes("-") && /^[|\s:-]+$/.test(d);
}

function preserveBlankLines(src: string): string {
  const lines = src.replace(/^\n+|\n+$/g, "").split("\n");
  let fence = "";
  let inTable = false;
  return lines
    .map((line, i) => {
      const run = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (run) {
        if (!fence) fence = run;
        else if (run.startsWith(fence.charAt(0)) && run.length >= fence.length) fence = "";
        inTable = false;
        return line;
      }
      if (fence) return line;
      if (line.trim() !== "") {
        if (startsGfmTable(line, lines[i + 1])) inTable = true;
        return line;
      }
      // A table can neither interrupt a paragraph nor survive a non-blank line below it, so blank lines around one stay blank.
      if (inTable) {
        inTable = false;
        return line;
      }
      return startsGfmTable(lines[i + 1], lines[i + 2]) ? line : ZWSP;
    })
    .join("\n");
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? textOf(node.props.children) : "";
}

const RESOLVED = "font-medium text-mention";
const UNRESOLVED = "text-muted-foreground/90";
const INTERACTIVE = "cursor-pointer rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40";

function tokenizeMentions(text: string, mentions: MessageMentions): ReactNode[] {
  if (!text.includes("@") && !text.includes("#")) return [text];
  return text.split(MENTION_TOKEN_RE).map((raw, i) => {
    if (i % 2 === 0) return raw;
    const token = raw.slice(1).toLowerCase();
    if (raw.startsWith("#")) {
      const channel = mentions.channelsByToken.get(token);
      return channel ? (
        <ChannelMentionLink
          key={i}
          channel={channel}
          isMember={mentions.currentUserChannelIds.has(channel.channel_id)}
          className={`${RESOLVED} ${INTERACTIVE}`}
        />
      ) : (
        <span key={i} className={UNRESOLVED}>{raw}</span>
      );
    }
    if (isHereToken(token)) {
      return (
        <span key={i} className="rounded bg-mention/10 px-0.5 font-semibold text-mention" title="Notifies everyone in this channel">
          {raw}
        </span>
      );
    }
    const member = mentions.memberByToken.get(token);
    if (!member) return <span key={i} className={UNRESOLVED}>{raw}</span>;
    const handle = `@${mentionHandle(member)}`;
    return (
      <ProfileMenuTrigger
        key={i}
        member={member}
        handleText={handle}
        className={`${RESOLVED} ${INTERACTIVE}`}
        ariaLabel={`Open profile menu for ${handle}`}
      >
        {handle}
      </ProfileMenuTrigger>
    );
  });
}

function Code({ children }: { children?: ReactNode }) {
  return (
    <code className="rounded-md bg-muted/70 px-1.5 py-px font-mono text-[0.85em] text-foreground/90 ring-1 ring-inset ring-border/50 break-all">
      {children}
    </code>
  );
}

function Pre({ children }: { children?: ReactNode }) {
  let lang: string | null = null;
  let code = "";
  Children.forEach(children, (child) => {
    if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
      lang = /language-([\w-]+)/.exec(child.props.className ?? "")?.[1] ?? lang;
      code = textOf(child.props.children);
    }
  });
  return <CodeBlock code={code.replace(/\n$/, "")} lang={lang} />;
}

function renderWithMentions(children: ReactNode, mentions: MessageMentions): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return <span>{tokenizeMentions(child, mentions)}</span>;
    if (!isValidElement<{ children?: ReactNode }>(child) || child.type === Code || child.type === Pre || child.props.children === undefined) {
      return child;
    }
    return cloneElement(child, undefined, renderWithMentions(child.props.children, mentions));
  });
}

function MentionText({ children }: { children: ReactNode }) {
  const mentions = use(MentionsContext);
  return mentions ? renderWithMentions(children, mentions) : children;
}

export const MessagePostContext = createContext<number | undefined>(undefined);

function openMcpSignIn(href: string, postId: number): void {
  const tab = isDesktop ? null : window.open("", "_blank");
  if (tab) tab.opener = null;
  claimMcpSignIn(href, postId).then(
    ({ url }) => (tab ? tab.location.replace(url) : void openExternal(url)),
    (err: unknown) => {
      tab?.close();
      toast.error(errMsg(err, "Could not start the sign-in"));
    },
  );
}

function MessageLink({ href, children }: { href?: string; children?: ReactNode }) {
  const postId = use(MessagePostContext);
  const signIn =
    href && postId !== undefined && isMcpSignInLink(href)
      ? (e: MouseEvent<HTMLAnchorElement>) => {
          e.preventDefault();
          openMcpSignIn(href, postId);
        }
      : undefined;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={signIn}
      className="text-[#007AFF] underline-offset-2 hover:underline break-words dark:text-[#0A84FF]"
    >
      {children}
    </a>
  );
}

const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0"><MentionText>{children}</MentionText></p>,
  a: ({ children, href }) => <MessageLink href={href}>{children}</MessageLink>,
  code: Code,
  pre: Pre,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-1 pl-6">{children}</ol>,
  li: ({ children }) => <li className="marker:tabular-nums marker:text-muted-foreground/70"><MentionText>{children}</MentionText></li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 rounded-r-md border-l-[3px] border-border bg-foreground/[0.03] py-1 pr-2 pl-3 text-muted-foreground">
      <MentionText>{children}</MentionText>
    </blockquote>
  ),
  h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-2xl font-semibold tracking-tight"><MentionText>{children}</MentionText></h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-xl font-semibold tracking-tight"><MentionText>{children}</MentionText></h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1 text-lg font-semibold"><MentionText>{children}</MentionText></h3>,
  h4: ({ children }) => <h4 className="mt-2 mb-1 text-base font-semibold"><MentionText>{children}</MentionText></h4>,
  h5: ({ children }) => <h5 className="mt-2 mb-1 text-[15px] font-semibold"><MentionText>{children}</MentionText></h5>,
  h6: ({ children }) => <h6 className="mt-2 mb-1 text-[15px] font-semibold text-muted-foreground"><MentionText>{children}</MentionText></h6>,
  hr: () => <hr className="my-3.5 border-border/70" />,
  table: ({ children }) => (
    <div className="my-2.5 overflow-x-auto rounded-lg ring-1 ring-inset ring-border/60">
      <table className="w-full border-collapse text-[0.9em]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-border/40 last:border-b-0">{children}</tr>,
  th: ({ children }) => (
    <th className="px-2.5 py-1.5 text-left text-[0.92em] font-semibold text-muted-foreground">
      <MentionText>{children}</MentionText>
    </th>
  ),
  td: ({ children }) => <td className="px-2.5 py-1.5 align-top"><MentionText>{children}</MentionText></td>,
};

const CHAT_PLUGINS = [remarkGfm, remarkBreaks];
const DOCUMENT_PLUGINS = [remarkGfm];

export const MessageMarkdown = memo(function MessageMarkdown({
  content,
  className,
  variant = "message",
}: {
  content: string;
  className?: string;
  variant?: "message" | "document";
}) {
  const emojiCount = classifyEmojiOnly(content);
  if (emojiCount > 0) {
    return (
      <p className={cn("my-1 first:mt-0 last:mb-0 text-foreground break-words", jumboEmojiClass(emojiCount), className)}>
        {content.trim()}
      </p>
    );
  }

  const chat = variant === "message";
  return (
    <div className={cn("text-message text-pretty text-foreground break-words", className)}>
      <ReactMarkdown remarkPlugins={chat ? CHAT_PLUGINS : DOCUMENT_PLUGINS} components={COMPONENTS} skipHtml>
        {chat ? preserveBlankLines(content) : content}
      </ReactMarkdown>
    </div>
  );
});
