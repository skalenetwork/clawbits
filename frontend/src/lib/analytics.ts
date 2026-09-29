/**
 * The app's side of the Umami setup: what leaves the browser, and the one
 * conversion event.
 *
 * The marketing site's tag is declarative markup (web/src/layouts/Base.astro).
 * The app's cannot be, for a reason worth stating: a landing page's URLs are
 * public documents, and an authenticated SPA's URLs are not. Umami sends the
 * full `location.href` on every pageview, and this app puts an email address in
 * the query string on `/login?email=` and `/verify-email?email=` and a tenant
 * UUID in the path on `/channels/<id>`. Left alone, the analytics of a product
 * whose privacy page promises "aggregate page views" would ship a list of its
 * users' email addresses to a third party.
 *
 * So the payload is rewritten on the way out - see `beforeSendPayload`, which
 * the tracker calls via its `data-before-send` hook.
 */

/** Umami's payload. Only the fields this module touches are named. */
interface UmamiPayload {
  url?: string;
  referrer?: string;
  title?: string;
  [key: string]: unknown;
}

interface UmamiGlobal {
  track: (name: string, data?: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    umami?: UmamiGlobal;
    /* Written by components/Analytics.tsx, read by the tracker. Spelled out
     * rather than computed from BEFORE_SEND below: a computed key in an
     * interface needs a unique symbol, and the tracker needs a string. */
    __clawbitsUmamiBeforeSend?: typeof beforeSendPayload;
  }
}

/**
 * The global the tracker looks the hook up on: it does `window[name]`, so this
 * has to be a property name rather than a function reference. Prefixed and
 * unlovely on purpose - it is a vendor integration point, not an export.
 */
export const BEFORE_SEND = "__clawbitsUmamiBeforeSend" as const;

/**
 * The ONLY query parameters allowed off the device.
 *
 * An allowlist rather than a denylist of `email`, `code`, `token`: a denylist
 * is a promise to remember, and the next parameter someone adds to a URL is
 * not going to be reviewed against it. The `utm_*` keys are here because the
 * landing site tags its CTAs with them (web/src/config.ts `appLink`) and Umami
 * reads them off `url` server-side to build its campaign report - drop them and
 * the marketing-to-app hop becomes unmeasurable, which is the whole reason the
 * two properties share a website ID.
 */
const ALLOWED_PARAMS = /^utm_(source|medium|campaign|term|content)$/;

/** Path segments that are identifiers, not pages. */
const OPAQUE_SEGMENT =
  /^([0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

/**
 * Collapse a URL to what a pageview report should contain.
 *
 * Identifiers become `:id` for two independent reasons. The obvious one is that
 * a channel UUID is a customer's data and does not belong in a third party's
 * database. The one that decides whether anyone ever reads the report is that
 * `/channels/<uuid>` is a DISTINCT ROW PER CHANNEL: leave them raw and the top
 * pages list is a few thousand one-visit URLs with the actual pages buried
 * underneath.
 */
export function sanitizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw, "https://app.invalid");
  } catch {
    /* Not parseable - send nothing rather than send it unexamined. */
    return "/";
  }

  url.pathname = url.pathname
    .split("/")
    .map((seg) => (OPAQUE_SEGMENT.test(seg) ? ":id" : seg))
    .join("/");

  for (const key of [...url.searchParams.keys()]) {
    if (!ALLOWED_PARAMS.test(key)) url.searchParams.delete(key);
  }

  /* The hash is a client-side detail here and can carry the same identifiers
   * the path does. Nothing in the report reads it. */
  url.hash = "";

  /* Match the shape the tracker gave us: it passes an absolute URL, but a
   * relative one round-trips unchanged rather than acquiring a fake origin. */
  const isAbsolute = /^[a-z]+:\/\//i.test(raw);
  return isAbsolute ? url.toString() : `${url.pathname}${url.search}`;
}

/**
 * The tracker's `data-before-send` hook. Returning the payload sends it;
 * returning a falsy value drops the event entirely.
 */
export function beforeSendPayload(_type: string, payload: UmamiPayload): UmamiPayload {
  if (typeof payload.url === "string") payload.url = sanitizeUrl(payload.url);
  /* The referrer is a URL someone else composed, so it gets the same treatment.
   * Umami reads campaigns off `url`, never off `referrer`, so nothing is lost. */
  if (typeof payload.referrer === "string") payload.referrer = sanitizeUrl(payload.referrer);
  /* AppShell puts the unread count in the title ("(3) Clawbits"), which would
   * otherwise split the title report into a row per badge value and send a
   * live signal about one person's inbox. */
  if (typeof payload.title === "string") payload.title = payload.title.replace(/^\(\d+\+?\)\s*/, "");
  return payload;
}

/**
 * Record a conversion. No-ops when the tracker is absent, which is every
 * environment except production - see components/Analytics.tsx.
 *
 * Never pass anything user-identifying. Umami stores event properties verbatim
 * and they are subject to exactly the same reasoning as the URL above.
 */
export function track(name: string, data?: Record<string, unknown>): void {
  try {
    window.umami?.track(name, data);
  } catch {
    /* Analytics must never break a flow it is only observing. */
  }
}
