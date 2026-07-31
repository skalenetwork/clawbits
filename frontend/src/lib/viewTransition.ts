import { flushSync } from "react-dom";

/**
 * Shared-element morph for the chat media viewer (native View Transitions API).
 *
 * Tapping a chat photo should make it glide/expand from its in-chat thumbnail
 * into the full-screen viewer, and morph back on close. We do this with the
 * browser-native API the app already relies on for route/sidebar transitions
 * (see the ``::view-transition-*`` block in ``index.css``) — no animation
 * library, GPU-composited by the browser.
 *
 * The mechanism: one ``view-transition-name`` is shared between the tapped
 * thumbnail and the full-screen ``<img>``. The browser snapshots the "old"
 * (thumbnail) and "new" (full-screen) states and morphs position + size
 * between them. The hard rule is that the name MUST be unique at snapshot
 * time — if two rendered elements carry it the browser skips the transition —
 * so we assign it to the source thumbnail only for the duration of the morph
 * and clear it afterwards. The full-screen image carries the name via React
 * for as long as the viewer is mounted.
 */

/** The single name shared by the tapped thumbnail and the full-screen image.
 *  Apply it to the viewer image with ``style={{ viewTransitionName: MEDIA_VT_NAME }}``. */
export const MEDIA_VT_NAME = "mm-media";

/** Whether we should run a real morph: API present and motion not suppressed.
 *  ``startViewTransition`` is typed as always-present in lib.dom, but it can be
 *  absent on older WebKit/WebKitGTK, so we still feature-detect at runtime. */
function canMorph(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  if (typeof document.startViewTransition !== "function") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function setName(el: HTMLElement | null | undefined): void {
  el?.style.setProperty("view-transition-name", MEDIA_VT_NAME);
}
function clearName(el: HTMLElement | null | undefined): void {
  el?.style.removeProperty("view-transition-name");
}

/**
 * Blur the app content (#root: sidebar, rail, chat) behind the viewer *for the
 * duration of the morph only*.
 *
 * The viewer dims/blurs its backdrop with `backdrop-filter`, which works fine
 * once it's live — but a `backdrop-filter` is NOT painted into View-Transition
 * snapshots. During the 360ms open/close morph the whole page is frozen as flat
 * bitmaps, so the backdrop blur only "snaps in" when the transition ends — the
 * lag users saw on the sidebar/rail. A plain `filter: blur()` on #root *is*
 * captured, so we toggle it on BEFORE `startViewTransition` (putting the blur in
 * the old snapshot, present from the first frame) and drop it once the morph
 * finishes, handing the steady-state blur back to the viewer's backdrop-filter.
 * The radius matches the viewer's `backdrop-blur-md` (12px) so the hand-off is
 * seamless. See the `html[data-media-viewer]` rule in index.css.
 */
function setMorphBlur(on: boolean): void {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  if (on) html.setAttribute("data-media-viewer", "");
  else html.removeAttribute("data-media-viewer");
}

/**
 * Open a media viewer with a morph from ``sourceEl`` (the tapped thumbnail)
 * into the full-screen image.
 *
 * ``open`` must synchronously mount the viewer; its image is expected to carry
 * ``MEDIA_VT_NAME``. Falls back to an instant open when the API is missing,
 * the user prefers reduced motion, or no source element was captured.
 */
export function openMediaWithTransition(
  sourceEl: HTMLElement | null | undefined,
  open: () => void,
): void {
  if (!canMorph() || !sourceEl) {
    // Live mount, no frozen snapshots — the viewer's own backdrop-filter blurs
    // the page immediately, so no morph-blur shim is needed.
    open();
    return;
  }
  // Name the source so it is captured as the "old" state the browser morphs
  // FROM. The snapshot is taken synchronously when startViewTransition is
  // called, so the name must already be set here.
  setName(sourceEl);
  // Blur #root before the snapshot so it's blurred from the morph's first frame.
  setMorphBlur(true);
  const transition = document.startViewTransition(() => {
    // Commit synchronously so the viewer (and its named full-screen image) is
    // in the DOM before the "new" snapshot is taken.
    flushSync(open);
    // Exactly one element may carry the name at snapshot time — the freshly
    // mounted image now has it, so drop it from the source.
    clearName(sourceEl);
  });
  // Hand the steady-state blur back to the viewer's backdrop-filter.
  const done = () => { clearName(sourceEl); setMorphBlur(false); };
  transition.finished.then(done, done);
}

/**
 * Close a media viewer, morphing the full-screen image back into ``sourceEl``.
 *
 * ``close`` must synchronously unmount the viewer. If the source thumbnail has
 * scrolled out of the virtualized message list (detached), the morph target is
 * skipped and the image simply animates out in place.
 */
export function closeMediaWithTransition(
  sourceEl: HTMLElement | null | undefined,
  close: () => void,
): void {
  // Unblur the page immediately on close: drop the morph-blur shim now so the
  // sidebar/rail/chat go sharp the instant the user closes, rather than staying
  // blurred while the image morphs back to its thumbnail. (The page snapshot is
  // already sharp from the morph's first frame — the viewer's backdrop-filter
  // isn't painted into the frozen snapshot — so the dim simply fades out over a
  // crisp page.) Also clears any shim left over from a still-settling open.
  setMorphBlur(false);
  if (!canMorph()) {
    close();
    return;
  }
  const transition = document.startViewTransition(() => {
    // Unmount the viewer first (its named image disappears), then name the
    // live thumbnail so it becomes the "new" state the browser morphs TO.
    flushSync(close);
    if (sourceEl?.isConnected) setName(sourceEl);
  });
  const done = () => { clearName(sourceEl); };
  transition.finished.then(done, done);
}

// ── Agent collectible-card hero morph (grid ⇆ detail) ───────────────────────

/** The name shared by the clicked binder card and the full detail card. The
 *  detail card carries it permanently (the `.vt-agent-card` class); the binder
 *  card only borrows it for the duration of a morph. */
export const AGENT_CARD_VT_NAME = "agent-card-hero";

/**
 * Resolve once an element matching `selector` is in the DOM (or after a safety
 * timeout). Uses a `MutationObserver`, NOT `requestAnimationFrame`: the render
 * loop is PAUSED while a view transition awaits its DOM-update callback, so rAF
 * never fires and the callback would hit the API's ~4s timeout and abort. DOM
 * mutations still dispatch on the normal event loop, so the observer sees the
 * new route mount. The timeout is a safety cap well under that 4s.
 */
export function waitForElement(selector: string, timeoutMs = 1000): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const found = () => document.querySelector<HTMLElement>(selector);
    const existing = found();
    if (existing) { resolve(existing); return; }
    let settled = false;
    const finish = (el: HTMLElement | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(el);
    };
    const observer = new MutationObserver(() => { const el = found(); if (el) finish(el); });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => { finish(found()); }, timeoutMs);
  });
}

/**
 * Drive an imperative agent-card hero morph across a client route change.
 *
 * This app uses the declarative `<BrowserRouter>`, so React Router's
 * `useViewTransitionState` isn't available AND its navigations commit through
 * `startTransition` (async) — a `flushSync` can't force the new route to mount
 * inside the transition callback. So we run an ASYNC callback: navigate, WAIT
 * for the destination card to render (`waitForTarget`), then let the browser
 * take the "new" snapshot.
 *
 * Naming, kept unique at snapshot time (a duplicate name aborts the morph):
 *   - forward (grid → detail): pass `nameSource` = the clicked binder card; the
 *     detail card names itself via the static class. The source name is dropped
 *     before the new snapshot so it can't duplicate the detail card's.
 *   - reverse (detail → grid): the detail card is the (statically-named) source;
 *     pass `nameTarget: true` to name the resolved binder card as the target.
 *
 * Falls back to a plain navigation when the API is missing or motion is reduced.
 */
export function morphAgentCardNavigation(opts: {
  navigate: () => void;
  waitForTarget: () => Promise<HTMLElement | null>;
  /** Element named as the "old" snapshot before the transition starts. */
  nameSource?: HTMLElement | null;
  /** Name the element `waitForTarget` resolves to as the "new" snapshot. */
  nameTarget?: boolean;
}): void {
  morphHeroNavigation({ ...opts, name: AGENT_CARD_VT_NAME });
}

// ── Automation card hero morph (gallery ⇆ detail) ───────────────────────────

/** Shared by a clicked automation card and the detail-page hero. The detail
 *  hero carries it statically via the `.vt-automation-hero` class; the gallery
 *  card only borrows it during the morph. */
export const AUTOMATION_VT_NAME = "automation-hero";

/** Inbox row → message morph (mobile). The message header carries it
 *  statically via `.vt-inbox-message`; the tapped row borrows it. */
export const INBOX_MESSAGE_VT_NAME = "inbox-message-hero";

/**
 * Generic cross-route shared-element morph — the mechanism behind
 * {@link morphAgentCardNavigation}, parameterized by `view-transition-name`
 * so other card→detail pairs (automations) reuse it. Same rules: the name
 * must be unique at snapshot time; the destination either carries it
 * statically (forward) or is named once resolved (`nameTarget`, reverse).
 */
export function morphHeroNavigation(opts: {
  name: string;
  navigate: () => void;
  waitForTarget: () => Promise<HTMLElement | null>;
  /** Element named as the "old" snapshot before the transition starts. */
  nameSource?: HTMLElement | null;
  /** Name the element `waitForTarget` resolves to as the "new" snapshot. */
  nameTarget?: boolean;
}): void {
  const { name, navigate, waitForTarget, nameSource, nameTarget } = opts;
  if (!canMorph()) { navigate(); return; }

  const clears: (() => void)[] = [];
  if (nameSource) {
    nameSource.style.setProperty("view-transition-name", name);
    clears.push(() => { nameSource.style.removeProperty("view-transition-name"); });
  }

  const transition = document.startViewTransition(async () => {
    navigate();
    const target = await waitForTarget();
    if (nameTarget && target) {
      target.style.setProperty("view-transition-name", name);
      clears.push(() => { target.style.removeProperty("view-transition-name"); });
    }
    // Ensure the source name is gone before the "new" snapshot: the detail card
    // carries the name statically, so a lingering source name would duplicate it.
    nameSource?.style.removeProperty("view-transition-name");
  });

  const cleanup = () => { for (const c of clears) c(); };
  transition.finished.then(cleanup, cleanup);
}
