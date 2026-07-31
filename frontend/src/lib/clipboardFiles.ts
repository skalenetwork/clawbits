/**
 * Clipboard → File extraction for the composer paste handler.
 *
 * OS screenshots (macOS Cmd+Shift+4, Windows Snip & Sketch, GNOME) land
 * on the clipboard as ``image.png`` — generic and indistinguishable
 * from each other once uploaded. We rename them to ``screenshot-{ISO}.png``
 * at the JS layer so the R2 object key, the server-side filename, and
 * the eventual download all carry a meaningful name.
 *
 * Files that already have a non-generic name pass through untouched.
 */

const GENERIC_PASTE_NAMES = new Set([
  "image.png",
  "image.jpg",
  "image.jpeg",
  "image.gif",
  "image.webp",
  "image",
  // Some browsers (notably Firefox on Linux) hand back the empty string.
  "",
]);

function extForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      // Pull from the slash-suffix or fall back to ``bin``.
      return mime.split("/")[1]?.replace(/[^a-z0-9]+/g, "") || "bin";
  }
}

function timestampForFilename(now: Date = new Date()): string {
  // ISO-ish, filesystem-safe: ``2026-05-13T15-30-22``.
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

function shouldRename(file: File): boolean {
  if (!file.type.startsWith("image/")) return false;
  return GENERIC_PASTE_NAMES.has(file.name.toLowerCase());
}

function renamed(file: File): File {
  const ext = extForMime(file.type);
  const newName = `screenshot-${timestampForFilename()}.${ext}`;
  // The File constructor preserves the bytes and ``type``; only the name
  // and ``lastModified`` change. Safe in all browsers since 2015.
  return new File([file], newName, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

/**
 * Pull ``File`` objects out of a paste event's clipboardData, renaming
 * generic ``image.png`` to ``screenshot-{ISO}.png`` on the way. Returns
 * an empty array when no file items are present (caller should then let
 * the textarea's default text-paste behaviour proceed).
 */
export function extractClipboardFiles(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const out: File[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (!f) continue;
    out.push(shouldRename(f) ? renamed(f) : f);
  }
  return out;
}
