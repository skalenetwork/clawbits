import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Spacious bullet list for release notes. Shared by the "What's new" dialog
 * (`ReleaseNotesDialog`) and the public changelog page (`ChangelogPage`) so the
 * notes render identically in both. Dedicated (not the chat renderer) so
 * spacing/typography are fully controlled - and `em` is forced upright so notes
 * never render italic.
 */
export function ReleaseNotesBody({ content }: { content: string }) {
  return (
    <div className="text-[15px] leading-relaxed text-foreground/90">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-1 space-y-3">{children}</ul>,
          li: ({ children }) => (
            <li className="flex gap-3">
              <span className="mt-[0.6em] size-1.5 shrink-0 rounded-full bg-foreground/35" aria-hidden />
              <span className="min-w-0 flex-1">{children}</span>
            </li>
          ),
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
          em: ({ children }) => <span className="not-italic">{children}</span>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-[#007AFF] underline-offset-2 hover:underline dark:text-[#0A84FF]"
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
