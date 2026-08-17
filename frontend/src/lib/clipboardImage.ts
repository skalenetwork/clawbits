/**
 * Copy a remote image to the system clipboard.
 *
 * Three browser constraints shape this module:
 *
 *  1. Chromium's async clipboard only accepts ``image/png`` for bitmaps, so
 *     anything else (JPEG, WebP, AVIF, GIF) has to be transcoded first.
 *  2. Safari drops the write if the ``ClipboardItem`` is constructed after an
 *     ``await`` - the item must be built synchronously inside the user gesture.
 *     It does accept a *promise* for the bytes, which is what we hand it, so
 *     the fetch + transcode can still happen asynchronously.
 *  3. ``navigator.clipboard.write`` and ``ClipboardItem`` are absent on older
 *     browsers and in insecure contexts - callers check ``canCopyImages()``
 *     first and hide the menu item when it returns false.
 */

/** Whether this browser can put image bytes on the clipboard at all. */
export function canCopyImages(): boolean {
  if (typeof window === "undefined" || typeof ClipboardItem === "undefined") return false;
  // Typed as always-present, but absent in insecure contexts — hence the cast.
  const clipboard = navigator.clipboard as Clipboard | undefined;
  return typeof clipboard?.write === "function";
}

/**
 * Put the image at ``url`` on the clipboard as PNG.
 *
 * MUST be called synchronously from a user gesture (a menu-item click) - see
 * constraint 2 above. ``url`` may be a *promise*, which is the point: callers
 * usually have to mint a fresh presigned URL first, and awaiting that before
 * building the ``ClipboardItem`` is exactly what Safari rejects. Rejects if the
 * fetch, the transcode, or the clipboard write fails; callers toast that.
 */
export async function copyImageToClipboard(url: string | Promise<string>): Promise<void> {
  // Built synchronously; the bytes arrive later via the promise.
  const item = new ClipboardItem({ "image/png": fetchAsPng(url) });
  await navigator.clipboard.write([item]);
}

async function fetchAsPng(urlOrPromise: string | Promise<string>): Promise<Blob> {
  const url = await urlOrPromise;
  // Presigned R2 URLs carry their auth in the query string, so no cookies -
  // and sending them cross-origin would only invite a CORS preflight.
  let res: Response;
  try {
    res = await fetch(url, { mode: "cors", credentials: "omit" });
  } catch {
    // Almost always the bucket's CORS policy, not the network: an <img> tag
    // renders these URLs without CORS, so the tile looks fine while this read
    // is refused. The bare "Failed to fetch" that lands here otherwise sends
    // people looking in the wrong place.
    throw new Error("The image host refused the read (CORS)");
  }
  if (!res.ok) throw new Error(`Could not fetch image (HTTP ${String(res.status)})`);
  const blob = await res.blob();
  if (blob.type === "image/png") return blob;
  return transcodeToPng(blob);
}

async function transcodeToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable");
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (out) => {
          if (out) resolve(out);
          else reject(new Error("Could not encode image"));
        },
        "image/png",
      );
    });
  } finally {
    bitmap.close();
  }
}
