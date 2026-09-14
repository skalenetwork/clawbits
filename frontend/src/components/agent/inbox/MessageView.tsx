import { useEffect, useRef } from "react";
import { PanelNote } from "@/components/sidebars/RightPanel";
import { Skeleton } from "@/components/ui/skeleton";
import type { EmailDetail } from "@/lib/api";
import { formatRelativeShort } from "@/lib/formatting";
import { errMsg, toast } from "@/lib/toast";
import { AttachmentTiles } from "./AttachmentTiles";
import { HtmlEmailFrame } from "./HtmlEmailFrame";
import { RawHeaders } from "./RawHeaders";
import { SenderMonogram } from "./SenderMonogram";
import { extractAddress, senderName } from "./emailDisplay";
import { useAgentEmail, useInboxInvalidate } from "./useInbox";

function EmailBody({ detail }: { detail: EmailDetail }) {
  const text = detail.body_text?.trim();
  if (text) return <div className="whitespace-pre-wrap break-words">{text}</div>;
  if (detail.body_html) return <HtmlEmailFrame html={detail.body_html} />;
  return <p className="italic text-muted-foreground">No content.</p>;
}

export function MessageView({ orgId, agentId, uid }: { orgId: string; agentId: string; uid: number }) {
  const { data, error, isSuccess } = useAgentEmail(orgId, agentId, uid);
  const invalidate = useInboxInvalidate(orgId, agentId);
  const marked = useRef(false);

  useEffect(() => {
    if (!isSuccess || marked.current) return;
    marked.current = true;
    invalidate();
  }, [isSuccess, invalidate]);

  if (!data) {
    return error ? (
      <PanelNote error>{errMsg(error, "Couldn't load message")}</PanelNote>
    ) : (
      <div className="flex flex-col gap-4.5 px-2.5">
        <Skeleton className="h-5 w-2/3" />
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-8 flex-1" />
        </div>
        <Skeleton className="h-32" />
      </div>
    );
  }

  const address = extractAddress(data.from_addr);

  return (
    <article className="flex flex-col gap-4.5 px-2.5 pb-4">
      <h3 className="text-base leading-snug font-semibold tracking-[-0.015em] text-balance">
        {data.subject || "(no subject)"}
      </h3>
      <div className="flex items-center gap-2.5">
        <SenderMonogram from={data.from_addr} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{senderName(data.from_addr)}</div>
          <button
            type="button"
            title="Copy address"
            onClick={() => {
              void navigator.clipboard.writeText(address);
              toast.success("Address copied");
            }}
            className="block max-w-full truncate text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {address}
          </button>
        </div>
        <span title={data.date} className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatRelativeShort(data.date)}
        </span>
      </div>
      <RawHeaders headers={data.headers} />
      <div className="border-t border-foreground/8 pt-4 text-[13.5px] leading-[1.6]">
        <EmailBody detail={data} />
      </div>
      <AttachmentTiles attachments={data.attachments} />
    </article>
  );
}
