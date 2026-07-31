// Shared email tunables. Kept in a dependency-free module so both the
// lightweight account resolver (`accounts.ts`) and the runtime poller
// (`email-poller.ts`) can import them without pulling the poller's HTTP/runtime
// graph into config resolution.

/** Default cadence between email mailbox polls. */
export const DEFAULT_EMAIL_POLL_MS = 60_000;
/** Floor on the poll cadence so a misconfig can't hammer the mailbox API. */
export const MIN_EMAIL_POLL_MS = 30_000;
