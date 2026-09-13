import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export function ReleaseNotesBody({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("text-[15px] leading-relaxed text-foreground/90", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-3 space-y-3 first:mt-0 last:mb-0">{children}</ul>,
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
