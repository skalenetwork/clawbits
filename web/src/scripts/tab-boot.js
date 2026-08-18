/*
 * Pre-paint tab restore for /agent-pit.
 *
 * WHY IT IS A FILE. This has to run BEFORE the body parses - the page's own tab
 * script is a module and therefore deferred, so by the time it runs the Reef
 * variant has already painted and someone opening a shared ?tab=self-hosted
 * link watches the page rewrite itself. Only an inline, blocking script is
 * early enough.
 *
 * But `is:inline` opts out of Astro's build-time hashing, and the production
 * CSP has no 'unsafe-inline' in script-src - so an inline block is refused by
 * the browser and silently does nothing. (Invisible in `astro dev`, which emits
 * no CSP at all; only `astro build` + `astro preview` reproduces it. The same
 * trap Base.astro documents for the shader's runtime stylesheet.)
 *
 * So the text lives here, the page injects it verbatim, and astro.config.mjs
 * hashes THIS FILE into script-src. One source, one hash - the alternative is a
 * hand-copied hash that goes stale the next time anyone edits a character here
 * and fails silently in production only.
 *
 * NO `define:vars`. That would rewrite the text per page and break the hash, so
 * the two known values are written out: the query key, and the fact that any
 * value other than the default is simply passed through to the attribute. An
 * unrecognised one lands on <html> and matches no CSS rule, which leaves the
 * page on the default tab - the same fallback the tab control itself applies.
 */
(function () {
  var want = new URL(location.href).searchParams.get("tab");
  if (want) document.documentElement.setAttribute("data-tab", want);
})();
