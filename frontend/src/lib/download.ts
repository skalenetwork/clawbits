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

/** Pull the file name out of a Content-Disposition header, preferring RFC 6266
 *  ``filename*`` over the ASCII ``filename`` fallback.
 *
 *  The server picks the name (it knows the channel and the export date), so
 *  this only has to survive a header that's missing or shaped unexpectedly —
 *  hence the caller-supplied fallback rather than a throw.
 */
export function filenameFromDisposition(
  header: string | null,
  fallback: string,
): string {
  const encoded = /filename\*=UTF-8''([^;\s]+)/i.exec(header ?? "")?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(header ?? "")?.[1]?.trim() ?? "";
  const name = encoded ? decodeURIComponent(encoded) : plain;
  return name.length > 0 ? name : fallback;
}
