import { useState } from "react";
import { LATEST_RELEASE, RELEASES, compareVersions, type Release } from "@/lib/releaseNotes";

const SEEN_KEY = "fc_release_notes_seen_version";
const FORCE_KEY = "fc_release_notes_force";

/** Production web only. Same signal as the backend's IS_PRODUCTION (domain.py):
 *  the prod host is clawbits.ai. The staging build serves the identical bundle
 *  on freeclaws.ai, so import.meta.env.PROD can't tell them apart — the host
 *  can. (Desktop/Tauri runs on tauri://localhost and is out of scope for v1.) */
function isProductionWeb(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.hostname === "clawbits.ai";
}

/** Off-prod preview escape hatch: ``?releaseNotes=force`` or a localStorage
 *  flag. Lets us see the modal on localhost/staging where the prod gate hides
 *  it. */
function isForced(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("releaseNotes") === "force") return true;
    return localStorage.getItem(FORCE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Decide, once at mount, which releases (if any) to surface:
 * - no record (new device / first rollout) → just the latest, then seed
 * - record older than latest → everything newer than it (the delta)
 * - record === latest → nothing
 *
 * Pure + synchronous — bundled releases, localStorage, and the hostname are all
 * available during render, so this runs in a lazy ``useState`` initialiser
 * rather than an effect (avoids the cascading-render anti-pattern).
 */
function computeInitial(): { open: boolean; releases: Release[] } {
  const none = { open: false, releases: [] as Release[] };
  if (!LATEST_RELEASE) return none;

  // Shown in production (clawbits.ai) and on the local Vite dev server (so
  // developers can see it), but NOT on the built staging site (freeclaws.ai) —
  // ``import.meta.env.DEV`` is true only for ``vite dev``, false for any build.
  // ``?releaseNotes=force`` overrides everywhere.
  const forced = isForced();
  if (!forced && !import.meta.env.DEV && !isProductionWeb()) return none;

  let lastSeen: string | null = null;
  try {
    lastSeen = localStorage.getItem(SEEN_KEY);
  } catch {
    lastSeen = null;
  }

  // Forced preview, or first run: show just the latest so existing users aren't
  // hit with the whole back-catalogue.
  if (forced || lastSeen == null) return { open: true, releases: [LATEST_RELEASE] };

  if (compareVersions(LATEST_RELEASE.version, lastSeen) > 0) {
    const unseen = RELEASES.filter((r) => compareVersions(r.version, lastSeen) > 0);
    return { open: true, releases: unseen.length > 0 ? unseen : [LATEST_RELEASE] };
  }
  return none;
}

export interface ReleaseNotesState {
  open: boolean;
  /** Releases to render, newest first. */
  releases: Release[];
  /** Close the modal and mark the latest version as seen. */
  dismiss: () => void;
}

/**
 * Drives the "What's new" modal. Mount ``ReleaseNotesDialog`` once in the authed
 * layout; it shows itself (prod web only) when a release is newer than what this
 * device last saw. See ``src/release-notes/``.
 */
export function useReleaseNotes(): ReleaseNotesState {
  const [state, setState] = useState(computeInitial);

  const dismiss = () => {
    // Keep ``releases`` so the content stays through the close animation; just
    // flip ``open`` and persist the seen marker.
    setState((s) => ({ ...s, open: false }));
    if (LATEST_RELEASE) {
      try {
        localStorage.setItem(SEEN_KEY, LATEST_RELEASE.version);
      } catch {
        /* ignore — non-fatal, modal may just reappear next load */
      }
    }
  };

  return { open: state.open, releases: state.releases, dismiss };
}
