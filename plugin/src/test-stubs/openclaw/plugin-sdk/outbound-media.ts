// Test stub for the host's outbound-media loader. Mirrors the contract the
// plugin relies on: remote http(s) URLs are fetched; anything else is treated
// as a host-approved local path and read via the provided readFile callback.
// Tests override `fetch` (or pass `mediaReadFile`) to control the bytes.

export interface OutboundMediaAccess {
  localRoots?: readonly string[];
  readFile?: (filePath: string) => Promise<Buffer>;
  workspaceDir?: string;
}

export interface OutboundMediaLoadOptions {
  maxBytes?: number;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[] | "any";
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  workspaceDir?: string;
}

export interface OutboundMediaLoadResult {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  kind?: string;
}

export async function loadOutboundMediaFromUrl(
  mediaUrl: string,
  options: OutboundMediaLoadOptions = {},
): Promise<OutboundMediaLoadResult> {
  const maxBytes = options.maxBytes ?? Infinity;
  if (/^https?:\/\//i.test(mediaUrl)) {
    const resp = await fetch(mediaUrl);
    if (!resp.ok) throw new Error(`media fetch failed: ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error("media exceeds maxBytes");
    const contentType = resp.headers.get("content-type") ?? undefined;
    return { buffer, ...(contentType ? { contentType } : {}) };
  }
  const readFile = options.mediaReadFile ?? options.mediaAccess?.readFile;
  if (!readFile) throw new Error(`no readFile available for local media: ${mediaUrl}`);
  const buffer = await readFile(mediaUrl);
  if (buffer.byteLength > maxBytes) throw new Error("media exceeds maxBytes");
  return { buffer };
}
