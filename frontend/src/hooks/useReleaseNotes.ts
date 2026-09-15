import { useState } from "react";
import { LATEST_RELEASE, compareVersions } from "@/lib/releaseNotes";

const SEEN_KEY = "fc_release_notes_seen_version";

function isForced(): boolean {
  try {
    return (
      new URLSearchParams(window.location.search).get("releaseNotes") === "force" ||
      localStorage.getItem("fc_release_notes_force") === "1"
    );
  } catch {
    return false;
  }
}

/** Latest release newer than this device's record. Shown on prod web and `vite dev`, never on the staging
 *  build, which serves the same bundle, so the gate is the hostname. `?releaseNotes=force` overrides. */
export function hasUnseenRelease(): boolean {
  if (!LATEST_RELEASE) return false;
  if (isForced()) return true;
  if (!import.meta.env.DEV && window.location.hostname !== "app.clawbits.ai") return false;
  try {
    const lastSeen = localStorage.getItem(SEEN_KEY);
    return lastSeen == null || compareVersions(LATEST_RELEASE.version, lastSeen) > 0;
  } catch {
    return true;
  }
}

export function useReleaseNotes() {
  const [open, setOpen] = useState(hasUnseenRelease);

  const dismiss = () => {
    setOpen(false);
    if (!LATEST_RELEASE) return;
    try {
      localStorage.setItem(SEEN_KEY, LATEST_RELEASE.version);
    } catch {
      /* storage blocked: the card reappears next load */
    }
  };

  return { open, dismiss };
}
