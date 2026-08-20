/** Save a blob to disk under ``filename``.
 *
 *  Goes through a same-origin object URL rather than pointing an anchor at
 *  the API path directly: the ``download`` attribute is ignored cross-origin,
 *  and a plain navigation to an authenticated endpoint would either open the
 *  JSON in a tab or lose the server's filename. The URL is revoked on a delay
 *  because revoking it in the same tick races the click in Chromium.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.click();
  window.setTimeout(() => { URL.revokeObjectURL(objectUrl); }, 10_000);
}

/** Pull ``filename="…"`` out of a Content-Disposition header.
 *
 *  The server picks the name (it knows the channel and the export date), so
 *  this only has to survive a header that's missing or shaped unexpectedly —
 *  hence the caller-supplied fallback rather than a throw.
 */
export function filenameFromDisposition(
  header: string | null,
  fallback: string,
): string {
  const match = /filename="?([^";]+)"?/i.exec(header ?? "");
  const name = match?.[1]?.trim() ?? "";
  return name.length > 0 ? name : fallback;
}
