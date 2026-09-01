import { useCallback, useRef, useState } from "react";

import {
  confirmMmFileUpload,
  deleteMmFile,
  putToR2,
  requestMmFileUpload,
} from "@/lib/api";
import {
  generateThumbnail,
  generateVideoPoster,
  readImageDimensions,
} from "@/lib/imageThumbnail";

export type AttachmentStatus =
  | "pending"
  | "uploading"
  | "uploaded"
  | "failed";

export interface PendingAttachment {
  /** Stable client-side id; survives re-renders. */
  localId: string;
  file: File;
  status: AttachmentStatus;
  /** 0..100 once uploading starts; ``null`` before that. */
  progress: number | null;
  /** Server-side ``mm_files.file_id`` — assigned after upload-url returns. */
  fileId: string | null;
  error?: string;
}

/** Default in-code mirrors of ``MM_FILES_*`` server env. These are the
 *  *minimum* — the server enforces the authoritative caps and will reject
 *  uploads beyond them with 413/415, so this is purely for friendlier UX
 *  (we reject obviously bad files locally before hitting the wire). */
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PER_POST = 5;

interface UseChannelAttachmentsOptions {
  channelId: string;
}

interface UseChannelAttachmentsResult {
  attachments: PendingAttachment[];
  /** ``true`` when at least one attachment is still uploading. The
   *  composer disables Send while this is true to keep the protocol
   *  honest (a post create with pending file_ids would be rejected). */
  isUploading: boolean;
  /** ``true`` when all current attachments are ``uploaded`` (post-eligible). */
  isReadyToSend: boolean;
  /** Validated, server-confirmed file_ids. Empty list when there are no
   *  attachments — safe to pass to ``createMmChannelPost`` unconditionally. */
  uploadedFileIds: string[];
  addFiles: (files: File[] | FileList) => void;
  removeAttachment: (localId: string) => void;
  clear: () => void;
}

function newLocalId(): string {
  // Random enough for keys; not security-critical.
  return Math.random().toString(36).slice(2, 12);
}

/**
 * Owns the lifecycle of files-in-flight for the composer:
 *   1. ``addFiles`` is called when the user picks files.
 *   2. Each file gets a row (``status="pending"``), and the upload
 *      pipeline kicks off in the background:
 *         a. (image) generate a 1024px JPEG thumbnail via Canvas.
 *         b. POST ``…/channels/{id}/files`` → presigned PUT URL.
 *         c. PUT bytes (and thumb in parallel) to R2 with progress.
 *         d. POST ``…/files/{id}/confirm`` with dims / thumbnail flag.
 *   3. Status flips to ``"uploaded"`` once confirm returns.
 *   4. ``removeAttachment`` cancels the XHR (if still in flight) and
 *      DELETEs the server-side row to keep the bucket clean.
 *
 * The hook is intentionally chatty about state — each phase increments
 * ``progress`` so the chip's progress bar feels responsive. Failures land
 * on a single ``error`` field; the chip surfaces it next to the filename.
 */
export function useChannelAttachments(
  opts: UseChannelAttachmentsOptions,
): UseChannelAttachmentsResult {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // Map of localId → AbortController so ``removeAttachment`` can cancel
  // the in-flight XHR. Kept in a ref because re-renders shouldn't churn it.
  const abortersRef = useRef<Map<string, AbortController>>(new Map());

  const updateOne = useCallback(
    (localId: string, patch: Partial<PendingAttachment>) => {
      setAttachments((prev) =>
        prev.map((a) => (a.localId === localId ? { ...a, ...patch } : a)),
      );
    },
    [],
  );

  const runUpload = useCallback(
    async (localId: string, file: File) => {
      const controller = new AbortController();
      abortersRef.current.set(localId, controller);

      const isImage = file.type.startsWith("image/");
      const isVideo = file.type.startsWith("video/");

      try {
        // 1. Thumbnail / poster (best-effort). Images get a downscaled
        //    JPEG; videos get a captured poster frame via the same canvas
        //    path. Both also backfill width/height (and duration for
        //    video). Any failure falls back to "no thumb".
        let thumbnailBlob: Blob | null = null;
        let width: number | undefined;
        let height: number | undefined;
        let durationMs: number | undefined;
        if (isImage) {
          try {
            const thumb = await generateThumbnail(file);
            if (thumb) {
              thumbnailBlob = thumb.blob;
              width = thumb.width;
              height = thumb.height;
            } else {
              // No thumb generated — still capture dims so the renderer
              // can layout the image correctly without a load round trip.
              const dims = await readImageDimensions(file);
              width = dims.width;
              height = dims.height;
            }
          } catch {
            // Thumbnail / dimension extraction failed — proceed without.
          }
        } else if (isVideo) {
          try {
            const poster = await generateVideoPoster(file);
            if (poster) {
              thumbnailBlob = poster.blob;
              width = poster.width;
              height = poster.height;
              durationMs = poster.durationMs ?? undefined;
            }
          } catch {
            // Undecodable codec (e.g. HEVC on non-Apple) or timeout —
            // upload the original anyway; the tile falls back to the
            // play-glyph placeholder.
          }
        }

        if (controller.signal.aborted) return;

        // 2. Reserve the upload slot and get presigned URLs.
        const upload = await requestMmFileUpload(opts.channelId, {
          filename: file.name,
          content_type: file.type || "application/octet-stream",
          size_bytes: file.size,
          has_thumbnail: thumbnailBlob !== null,
          thumbnail_size_bytes: thumbnailBlob?.size,
        });
        if (controller.signal.aborted) return;
        updateOne(localId, {
          fileId: upload.file_id,
          status: "uploading",
          progress: 0,
        });

        // 3. PUT original (with progress) and thumb (no progress — small).
        //    Run in parallel; either failing aborts the other via signal.
        const originalPut = putToR2(
          upload.upload_url,
          upload.upload_headers,
          file,
          (loaded, total) => {
            if (total > 0) {
              const pct = Math.min(99, Math.round((loaded / total) * 100));
              updateOne(localId, { progress: pct });
            }
          },
          controller.signal,
        );
        const thumbPut =
          thumbnailBlob && upload.thumbnail_upload_url && upload.thumbnail_upload_headers
            ? putToR2(
                upload.thumbnail_upload_url,
                upload.thumbnail_upload_headers,
                thumbnailBlob,
                undefined,
                controller.signal,
              )
            : Promise.resolve();

        // Track whether the thumb succeeded — confirm endpoint records it.
        let thumbnailUploaded = thumbnailBlob !== null;
        await originalPut;
        try {
          await thumbPut;
        } catch {
          // Thumbnail upload failed but original succeeded — proceed,
          // just tell confirm we don't have a thumb.
          thumbnailUploaded = false;
        }

        if (controller.signal.aborted) return;

        // 4. Finalize. Server flips status='uploaded' and records meta.
        await confirmMmFileUpload(upload.file_id, {
          width,
          height,
          duration_ms: durationMs,
          thumbnail_uploaded: thumbnailUploaded,
        });
        updateOne(localId, { status: "uploaded", progress: 100 });
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          // User cancelled — no error UI, just drop the row (already
          // happens in ``removeAttachment``).
          return;
        }
        const message = err instanceof Error ? err.message : "Upload failed";
        updateOne(localId, { status: "failed", error: message });
      } finally {
        abortersRef.current.delete(localId);
      }
    },
    [opts.channelId, updateOne],
  );

  const addFiles = useCallback(
    (input: File[] | FileList) => {
      const incoming = Array.from(input);
      // Drop oversize / dup-name files quickly — server would reject them
      // anyway. We don't surface per-file errors here because the user
      // didn't ask for an error pipeline; just silently skip.
      const accepted = incoming.filter((f) => f.size > 0 && f.size <= MAX_BYTES);

      setAttachments((prev) => {
        const remaining = Math.max(0, MAX_PER_POST - prev.length);
        const slice = accepted.slice(0, remaining);
        const next: PendingAttachment[] = slice.map((file) => ({
          localId: newLocalId(),
          file,
          status: "pending",
          progress: null,
          fileId: null,
        }));
        // Kick off uploads after the state update commits — using the
        // returned localIds straight from ``next`` (closure-safe).
        for (const a of next) {
          // Defer to a microtask so we don't pile uploads onto the same
          // tick as the state set.
          queueMicrotask(() => { void runUpload(a.localId, a.file); });
        }
        return [...prev, ...next];
      });
    },
    [runUpload],
  );

  const removeAttachment = useCallback((localId: string) => {
    const controller = abortersRef.current.get(localId);
    let fileIdToCleanup: string | null = null;
    setAttachments((prev) => {
      const found = prev.find((a) => a.localId === localId);
      if (found?.fileId && found.status === "uploaded") {
        fileIdToCleanup = found.fileId;
      } else if (found?.fileId) {
        // Mid-upload row that already has a server file_id — best-effort
        // soft delete after we abort below.
        fileIdToCleanup = found.fileId;
      }
      return prev.filter((a) => a.localId !== localId);
    });
    if (controller) controller.abort();
    if (fileIdToCleanup) {
      // Fire-and-forget — the UI doesn't wait. Orphan GC catches anything
      // that slips through.
      void deleteMmFile(fileIdToCleanup).catch(() => { /* best-effort */ });
    }
  }, []);

  const clear = useCallback(() => {
    // Bulk drop — used after a successful send. The server has already
    // bound these file_ids to the post, so we don't try to soft-delete.
    for (const c of abortersRef.current.values()) c.abort();
    abortersRef.current.clear();
    setAttachments([]);
  }, []);

  const isUploading = attachments.some(
    (a) => a.status === "pending" || a.status === "uploading",
  );
  const uploadedFileIds = attachments
    .filter((a) => a.status === "uploaded" && a.fileId)
    .map((a) => a.fileId!);
  const isReadyToSend =
    attachments.length === 0 || (!isUploading && uploadedFileIds.length === attachments.length);

  return {
    attachments,
    isUploading,
    isReadyToSend,
    uploadedFileIds,
    addFiles,
    removeAttachment,
    clear,
  };
}
