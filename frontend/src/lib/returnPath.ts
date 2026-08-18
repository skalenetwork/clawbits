/**
 * Post-login destination handling.
 *
 * When a signed-out visitor opens a deep link (``/agents/abc/manage``), the
 * app bounces them to ``/login`` and the path they asked for is remembered in
 * a ``?next=`` parameter. Every login flow reads it back on success. Four
 * places used to hardcode ``/home`` and each is now routed through here.
 *
 * THIS FILE IS THE ONLY THING BETWEEN ``?next=`` AND AN OPEN REDIRECT.
 *
 * The parameter is attacker-supplied by definition: anyone can send a victim
 * ``https://app.clawbits.ai/login?next=<anything>``. If that value ever
 * reaches a navigation without being checked, the app becomes a credible
 * launch pad for phishing — the victim signs in on the real Clawbits domain
 * and is then handed to whatever the link said. So the rule is a whitelist,
 * not a blacklist: a value is used only if it is provably a path on this
 * origin, and anything else silently becomes ``/home``.
 *
 * `clawbits/fastapi/workos_auth.py` carries a deliberate mirror of this for
 * the OAuth leg, which returns through the backend rather than through the
 * SPA. Change one, change both.
 */

/** Query parameter carrying the remembered destination. */
export const NEXT_PARAM = "next";

/** Where every flow lands when there is no safe destination to return to. */
export const DEFAULT_LANDING = "/home";

/**
 * Routes that must never be a return destination.
 *
 * Returning to a login route after logging in is at best a no-op and at worst
 * a loop: ``GuestOnly`` bounces a signed-in visitor off ``/login``, and if it
 * bounced them to ``/login`` the app would spin.
 */
const NEVER_RETURN_TO = ["/login", "/verify-email"];

/** Long enough for any real deep link; short enough not to be a payload. */
const MAX_LENGTH = 512;

/**
 * Validate a caller-supplied destination.
 *
 * @returns the path (with query and hash preserved) when it is a safe
 *   same-origin destination, or ``null`` when it is anything else.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_LENGTH) return null;

  // Must be rooted. `//evil.com` is protocol-relative and `/\evil.com` is the
  // same thing to a browser, which normalises the backslash — both would send
  // the visitor to another origin while *looking* like a path.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;

  // Control characters are how a scheme gets smuggled past a prefix check
  // (a leading newline before "javascript:", say), and a raw newline reaching
  // the backend would be header injection into Location. Written as escapes,
  // never as literal bytes - a control character in source is invisible in a
  // diff and one careless save from silently disappearing.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;

  // The prefix checks above are the readable guard; this is the authoritative
  // one. Resolving against a base that can never be our origin means anything
  // carrying its own scheme or authority resolves away from `x.invalid` and is
  // caught here, however it was spelled.
  let url: URL;
  try {
    url = new URL(raw, "https://x.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://x.invalid") return null;

  const path = `${url.pathname}${url.search}${url.hash}`;
  if (NEVER_RETURN_TO.some((p) => path === p || path.startsWith(`${p}?`) || path.startsWith(`${p}/`))) {
    return null;
  }
  return path;
}

/**
 * The current location, as a value safe to hand to {@link safeReturnPath}.
 * Returns ``null`` for the default landing page, so the common case produces
 * a clean ``/login`` with no parameter rather than ``/login?next=%2Fhome``.
 */
export function captureReturnPath(location: {
  pathname: string;
  search: string;
  hash: string;
}): string | null {
  const here = `${location.pathname}${location.search}${location.hash}`;
  if (here === DEFAULT_LANDING || here === "/") return null;
  return safeReturnPath(here);
}

/** ``/login``, carrying ``next`` only when there is something worth carrying. */
export function loginPathFor(next: string | null): string {
  return next ? `/login?${NEXT_PARAM}=${encodeURIComponent(next)}` : "/login";
}
