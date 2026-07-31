/**
 * HtmlEmailFrame — renders untrusted HTML mail in a hardened, auto-sizing
 * iframe.
 *
 * Sandbox posture (load-bearing, don't loosen casually):
 * - ``allow-same-origin`` WITHOUT ``allow-scripts``: no script can ever run
 *   (inline, external, handlers, javascript: URLs), while the parent can read
 *   ``contentDocument`` to measure content height (the old ``sandbox=""``
 *   frame was opaque-origin, hence the fixed 60vh). The classic
 *   sandbox-escape hazard needs BOTH tokens.
 * - With same-origin granted, passive subresources would otherwise load as
 *   credentialed same-origin GETs (tracking pixels, /api side-effect URLs) —
 *   the injected CSP <meta> blocks everything except inline styles and
 *   data:/cid: images. Standard mail-privacy posture; remote images are
 *   blocked for now.
 * - ``allow-popups`` + ``<base target="_blank">`` so links open in a real
 *   tab; no ``allow-top-navigation``, so mail can never take over the app.
 */
import { useIframeAutoHeight } from "./useIframeAutoHeight";

const FRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:; font-src data:";

/** Wrap the (possibly full-document) email HTML in our shell. Browsers parse
 *  nested <html>/<head> leniently, and our CSP <meta> comes first — before
 *  any of the email's own markup — so it governs every subresource. */
function buildSrcDoc(html: string): string {
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`,
    '<base target="_blank">',
    "<style>",
    ":root{color-scheme:light}",
    "body{margin:16px;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;word-break:break-word}",
    "img{max-width:100%;height:auto}",
    "</style>",
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}

export function HtmlEmailFrame({ html }: { html: string }) {
  const { ref, height, onLoad } = useIframeAutoHeight();
  return (
    <iframe
      ref={ref}
      title="Message body"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={buildSrcDoc(html)}
      onLoad={onLoad}
      style={{ height }}
      className="w-full rounded-xl border border-border/60 bg-white"
    />
  );
}
