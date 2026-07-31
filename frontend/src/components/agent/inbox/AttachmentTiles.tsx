/**
 * AttachmentTiles — the message's attachments as a visual tile grid. Images
 * render real thumbnails (their bytes already arrive base64-encoded in the
 * detail payload); every other type gets a tinted file-type icon well. A tile
 * click downloads via the data: URL, same as the old chips.
 */
import {
  Attachment01Icon,
  Download01Icon,
  File01Icon,
  FileAudioIcon,
  FileVideoIcon,
  FileZipIcon,
  DocumentAttachmentIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/Icon";
import { SectionHeader } from "@/components/automations/SectionHeader";
import { humanSize } from "@/lib/formatting";
import type { EmailAttachment } from "@/lib/api";
import { cn } from "@/lib/utils";

function attachmentHref(a: EmailAttachment): string | null {
  if (!a.content_b64) return null;
  const type = a.content_type || "application/octet-stream";
  return `data:${type};base64,${a.content_b64}`;
}

/** Icon + tint per broad content-type family. Quiet washes, colored glyphs —
 *  the same soft register as the sender monograms. */
function typeVisual(a: EmailAttachment): { icon: IconSvgElement; well: string } {
  const type = (a.content_type || "").toLowerCase();
  const name = a.filename.toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf"))
    return { icon: DocumentAttachmentIcon, well: "bg-rose-500/15 text-rose-600 dark:text-rose-400" };
  if (type.startsWith("audio/"))
    return { icon: FileAudioIcon, well: "bg-violet-500/15 text-violet-600 dark:text-violet-400" };
  if (type.startsWith("video/"))
    return { icon: FileVideoIcon, well: "bg-blue-500/15 text-blue-600 dark:text-blue-400" };
  if (/zip|compressed|tar|gzip|x-7z/.test(type) || /\.(zip|tar|gz|tgz|rar|7z)$/.test(name))
    return { icon: FileZipIcon, well: "bg-amber-500/15 text-amber-600 dark:text-amber-400" };
  return { icon: File01Icon, well: "bg-muted/70 text-muted-foreground" };
}

function ImageTile({ a, href }: { a: EmailAttachment; href: string }) {
  return (
    <a
      href={href}
      download={a.filename}
      title={`Download ${a.filename}`}
      className="group overflow-hidden rounded-xl border border-border/60 transition-colors hover:border-border"
    >
      <img src={href} alt={a.filename} loading="lazy" className="h-24 w-full object-cover" />
      <span className="flex items-center gap-1.5 px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate text-caption text-foreground">{a.filename}</span>
        <span className="shrink-0 text-label text-muted-foreground">{humanSize(a.size)}</span>
      </span>
    </a>
  );
}

function FileTile({ a, href }: { a: EmailAttachment; href: string | null }) {
  const { icon, well } = typeVisual(a);
  const inner = (
    <>
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", well)}>
        <Icon icon={icon} className="size-4.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{a.filename}</span>
        <span className="block text-label text-muted-foreground">{humanSize(a.size)}</span>
      </span>
      {href && (
        <Icon
          icon={Download01Icon}
          className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground"
        />
      )}
    </>
  );
  const cls =
    "group flex items-center gap-2.5 rounded-xl border border-border/60 bg-card px-3 py-2.5 transition-colors";
  return href ? (
    <a href={href} download={a.filename} title={`Download ${a.filename}`} className={cn(cls, "hover:border-border hover:bg-muted/40")}>
      {inner}
    </a>
  ) : (
    <span className={cn(cls, "opacity-70")} title="Attachment unavailable">
      {inner}
    </span>
  );
}

export function AttachmentTiles({ attachments }: { attachments: EmailAttachment[] }) {
  if (attachments.length === 0) return null;
  // Images tile in a grid (thumbnails stay compact); other files stack as
  // full-width rows — the reading pane is a narrow container, so viewport
  // breakpoints can't be trusted to keep tiles readable.
  const images: { a: EmailAttachment; href: string }[] = [];
  const files: { a: EmailAttachment; href: string | null }[] = [];
  for (const a of attachments) {
    const href = attachmentHref(a);
    if (href && (a.content_type || "").toLowerCase().startsWith("image/")) {
      images.push({ a, href });
    } else {
      files.push({ a, href });
    }
  }
  return (
    <div className="space-y-3">
      <SectionHeader icon={Attachment01Icon}>
        {attachments.length === 1 ? "Attachment" : `${String(attachments.length)} attachments`}
      </SectionHeader>
      {images.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {images.map(({ a, href }, i) => (
            <ImageTile key={i} a={a} href={href} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-col gap-2">
          {files.map(({ a, href }, i) => (
            <FileTile key={i} a={a} href={href} />
          ))}
        </div>
      )}
    </div>
  );
}
