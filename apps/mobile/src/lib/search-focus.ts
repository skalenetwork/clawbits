// Tiny cross-tab signal so the Home search bar can hand focus to the Search
// tab's input. Home sets the flag then navigates; the Search screen consumes it
// in a focus effect and focuses the field. A module flag (not a route param)
// keeps it working whether or not the Search tab is already mounted, and avoids
// leaving a stale ?focus= in the URL.

let pending = false;

/** Call right before navigating to the Search tab to request input focus. */
export function requestSearchFocus(): void {
  pending = true;
}

/** Read-and-clear the pending focus request. Returns true once per request. */
export function consumePendingSearchFocus(): boolean {
  const had = pending;
  pending = false;
  return had;
}
