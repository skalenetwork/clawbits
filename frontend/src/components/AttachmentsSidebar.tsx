import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { ContextualHeader } from "@/components/sidebars/ContextualHeader";
import { AttachmentTabs } from "@/components/attachments/AttachmentTabs";
import { MediaTab } from "@/components/attachments/MediaTab";
import { FilesTab } from "@/components/attachments/FilesTab";
import { LinksTab } from "@/components/attachments/LinksTab";
import { useAttachmentTab } from "@/lib/attachmentTabs";

/**
 * Right-edge Attachments panel — the per-channel media / files / links
 * browser. Mirrors ``ChatInfoSidebar`` exactly: a width-animated ``<aside>``
 * (data-state expanded/collapsed) mounted as a flex sibling outside the
 * content card, with the same frosted ``ContextualHeader`` and the
 * header-over-tabs-over-scroll layout the ``ChatsSidebar`` uses.
 *
 * Only the active tab is mounted, and its query is gated on ``open`` so a
 * collapsed panel never fetches; opening it (or switching tabs) triggers
 * the load.
 */
export default function AttachmentsSidebar({
  channelId,
  open,
  onClose,
}: {
  channelId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useAttachmentTab();

  return (
    <aside
      data-state={open ? "expanded" : "collapsed"}
      aria-hidden={!open}
      className="hidden shrink-0 justify-end overflow-hidden pb-2 pt-[max(var(--titlebar-height),0.5rem)] transition-[width] duration-200 ease-linear md:flex data-[state=collapsed]:w-0 data-[state=expanded]:w-[calc(var(--sidebar-width)+3.5rem)]"
    >
      <div className="relative mr-2 flex h-full w-[calc(var(--sidebar-width)+3rem)] shrink-0 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-panel text-sidebar-foreground">
        <ContextualHeader
          title="Attachments"
          action={
            <button
              type="button"
              onClick={onClose}
              aria-label="Close attachments"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon icon={Cancel01Icon} className="size-4" />
            </button>
          }
        />
        {/* Type tabs, snug below the header — same placement as ChatsSidebar. */}
        <div className="absolute inset-x-0 top-12 z-10 px-2 pt-1">
          <AttachmentTabs value={tab} onValueChange={setTab} />
        </div>
        {/* Scroll region clears the header (3rem) + the tabs section. */}
        <div className="no-scrollbar flex-1 overflow-y-auto px-2 pb-3 pt-[5.75rem]">
          {tab === "media" && <MediaTab channelId={channelId} active={open} />}
          {tab === "files" && <FilesTab channelId={channelId} active={open} />}
          {tab === "links" && <LinksTab channelId={channelId} active={open} />}
        </div>
      </div>
    </aside>
  );
}
