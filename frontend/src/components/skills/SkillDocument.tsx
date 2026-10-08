import { MessageMarkdown } from "@/components/MessageMarkdown";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const LEADING_H1 = /^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/;
/** A top-level key beyond the name and description, which the page already shows. */
const EXTRA_KEY = /^(?!(?:name|description)\s*:)[^\s#]/m;

/** The one SKILL.md renderer: frontmatter is for the loader and the body is what the agent reads, so they render
 *  apart, and a leading H1 that only repeats the skill's name is dropped. `compact` leaves the frontmatter out. */
export function SkillDocument({
  markdown,
  displayName,
  compact = false,
}: {
  markdown: string;
  displayName: string;
  compact?: boolean;
}) {
  const front = FRONTMATTER.exec(markdown);
  let body = front ? markdown.slice(front[0].length) : markdown;
  const heading = LEADING_H1.exec(body);
  if (heading && heading[1]?.trim().toLowerCase() === displayName.trim().toLowerCase()) {
    body = body.slice(heading[0].length);
  }
  const meta = compact ? undefined : front?.[1];
  return (
    <div className="flex flex-col gap-3">
      {meta && EXTRA_KEY.test(meta) && (
        <pre className="rounded-[10px] border border-foreground/8 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap wrap-anywhere text-muted-foreground">
          {meta}
        </pre>
      )}
      <MessageMarkdown content={body} variant="document" />
    </div>
  );
}
