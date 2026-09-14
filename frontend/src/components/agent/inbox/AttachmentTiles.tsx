import {
  DocumentAttachmentIcon,
  File01Icon,
  FileAudioIcon,
  FileVideoIcon,
  FileZipIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import type { EmailAttachment } from "@/lib/api";
import { humanSize } from "@/lib/formatting";
import { cn } from "@/lib/utils";

const TILE = "overflow-hidden rounded-[10px] bg-foreground/5 transition-colors";

function typeIcon({ content_type, filename }: EmailAttachment) {
  const type = content_type.toLowerCase();
  const name = filename.toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return DocumentAttachmentIcon;
  if (type.startsWith("audio/")) return FileAudioIcon;
  if (type.startsWith("video/")) return FileVideoIcon;
  if (/zip|compressed|tar|gzip|x-7z/.test(type) || /\.(zip|tar|gz|tgz|rar|7z)$/.test(name)) return FileZipIcon;
  return File01Icon;
}

export function AttachmentTiles({ attachments }: { attachments: EmailAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="grid grid-flow-dense grid-cols-2 gap-2">
      {attachments.map((a, i) => {
        const href = a.content_b64
          ? `data:${a.content_type || "application/octet-stream"};base64,${a.content_b64}`
          : undefined;
        const size = <span className="shrink-0 text-xs text-muted-foreground">{humanSize(a.size)}</span>;
        return href && a.content_type.toLowerCase().startsWith("image/") ? (
          <a key={i} href={href} download={a.filename} title={`Download ${a.filename}`} className={cn(TILE, "hover:bg-foreground/8")}>
            <img src={href} alt={a.filename} loading="lazy" className="h-24 w-full object-cover" />
            <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate">{a.filename}</span>
              {size}
            </span>
          </a>
        ) : (
          <a
            key={i}
            href={href}
            download={href && a.filename}
            title={href ? `Download ${a.filename}` : "Attachment unavailable"}
            className={cn(
              TILE,
              "col-span-2 flex items-center gap-2.5 px-3 py-2.5 text-[13px]",
              href ? "hover:bg-foreground/8" : "opacity-70",
            )}
          >
            <Icon icon={typeIcon(a)} className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{a.filename}</span>
            {size}
          </a>
        );
      })}
    </div>
  );
}
