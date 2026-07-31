import { useCallback, useState } from "react";
import {
  File02Icon,
  Image02Icon,
  Link01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

/** The type-split tabs at the top of the Attachments sidebar. */
export type AttachmentTab = "media" | "files" | "links";

/** Tab descriptors in display order — drives the segmented control. */
export const ATTACHMENT_TABS: { id: AttachmentTab; label: string; icon: IconSvgElement }[] = [
  { id: "media", label: "Media", icon: Image02Icon },
  { id: "files", label: "Files", icon: File02Icon },
  { id: "links", label: "Links", icon: Link01Icon },
];

const STORAGE_KEY = "fc_attachments_tab";

function isAttachmentTab(v: string | null): v is AttachmentTab {
  return v === "media" || v === "files" || v === "links";
}

/**
 * Persisted Attachments-tab selection (localStorage, mirroring
 * ``useChatTab``). A single global value — the desktop sidebar and the
 * mobile drawer share it and are never mounted at the same time.
 */
export function useAttachmentTab(): [AttachmentTab, (tab: AttachmentTab) => void] {
  const [tab, setTabState] = useState<AttachmentTab>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isAttachmentTab(stored) ? stored : "media";
  });
  const setTab = useCallback((next: AttachmentTab) => {
    setTabState(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);
  return [tab, setTab];
}
