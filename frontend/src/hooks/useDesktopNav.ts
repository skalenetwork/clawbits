import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { useDesktopEvent } from "@/hooks/useDesktopEvent";
import { createMmChannelPost } from "@/lib/api";
import { draftStore } from "@/lib/messageDrafts";
import { errMsg, toast } from "@/lib/toast";

/**
 * Routes the native menus, tray and notification clicks through react-router,
 * and posts replies typed into a notification banner; a reply that fails to
 * send becomes the channel's draft, so it is never lost. Cmd+[ and Cmd+] also
 * work in the browser build.
 */
export function useDesktopNav() {
  const navigate = useNavigate();
  const userId = useAuth().user?.id;

  useDesktopEvent("desktop://navigate", (to) => {
    if (to === "back") void navigate(-1);
    else if (to === "forward") void navigate(1);
    else if (to.startsWith("/")) void navigate(to);
  });

  useDesktopEvent("desktop://reply", ({ channelId, text }) => {
    if (userId == null || !text.trim()) return;
    createMmChannelPost(channelId, text).catch((e: unknown) => {
      const draft = draftStore.get(userId, channelId);
      draftStore.set(userId, channelId, { reply: null, targetAgentId: null, ...draft, text: draft?.text ? `${draft.text}\n${text}` : text });
      toast.error(errMsg(e, "Couldn't send your reply"), { description: "It's saved as a draft in that chat." });
    });
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "[") { e.preventDefault(); void navigate(-1); }
      else if (e.key === "]") { e.preventDefault(); void navigate(1); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [navigate]);
}
