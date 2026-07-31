/**
 * Client-side image + video thumbnail generation via Canvas.
 *
 * Used by the composer to produce 1024px JPEG previews that get uploaded
 * to R2 alongside the original. Means message-list rendering can load
 * cheap thumbnails instead of full-resolution originals. For video the
 * same pipeline captures a poster frame from a decoded ``<video>`` so
 * tiles render a real frame instead of a blank box.
 */

export interface ThumbnailResult {
  blob: Blob;
  width: number;
  height: number;
}

export interface VideoPosterResult {
  /** JPEG poster frame. (The R2 thumbnail PUT signature pins
   *  ``image/jpeg``, so this must be JPEG, not WebP.) */
  blob: Blob;
  /** Intrinsic video dimensions — backfills the otherwise-null
   *  ``width``/``height`` on the file so the renderer can reserve the
   *  right aspect-ratio box and avoid a layout jump. */
  width: number;
  height: number;
  /** Duration in ms, or ``null`` when the container didn't expose it
   *  (e.g. some streamed WebM). Drives the duration pill. */
  durationMs: number | null;
}

export interface ImageMetadata {
  width: number;
  height: number;
}

/** Decode an image File into an ``HTMLImageElement``. Resolves once the
 *  bitmap is loaded; rejects on decode failure. Caller is responsible for
 *  ``URL.revokeObjectURL`` on the returned object URL when done. */
function loadImage(file: Blob): Promise<{ img: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to decode image"));
    };
    img.src = url;
  });
}

/** Read width/height of an image without decoding pixels into a canvas.
 *  Cheap — used to record dimensions in the ``/confirm`` payload even
 *  when the file is too small to need a thumbnail. */
export async function readImageDimensions(file: File): Promise<ImageMetadata> {
  const { img, url } = await loadImage(file);
  try {
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Produce a JPEG thumbnail (at most ``maxDimension`` px on the longer
 * side) from ``file``. Returns the blob plus the original (full-res)
 * dimensions so callers can record them on confirm.
 *
 * Returns ``null`` if:
 *   - the image is already smaller than ``maxDimension`` — uploading a
 *     "thumbnail" larger than the original is silly
 *   - the canvas pipeline failed (e.g. CORS-tainted source — shouldn't
 *     happen for user-picked files, but be defensive)
 */
export async function generateThumbnail(
  file: File,
  maxDimension: number = 1024,
  quality: number = 0.82,
): Promise<ThumbnailResult | null> {
  if (!file.type.startsWith("image/")) return null;

  const { img, url } = await loadImage(file);
  try {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const longest = Math.max(w, h);
    if (longest <= maxDimension) {
      // Source is already small enough — skip and let the original
      // double as the thumbnail. Composer falls back gracefully.
      return null;
    }
    const scale = maxDimension / longest;
    const tw = Math.round(w * scale);
    const th = Math.round(h * scale);

    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, tw, th);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
    });
    if (!blob) return null;
    return { blob, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Video poster
// ---------------------------------------------------------------------------

/** Hard ceiling on poster extraction so an undecodable/huge file can't hang
 *  the upload pipeline forever. On timeout we fall back to "no poster". */
const VIDEO_POSTER_TIMEOUT_MS = 12_000;

/**
 * Capture a poster frame from a user-picked video ``File``, mirroring
 * ``generateThumbnail`` so video takes the same R2 thumbnail path as
 * images (no backend transcode, no ffmpeg).
 *
 * The source is a *local* ``File`` loaded via an object URL — a same-origin
 * ``blob:`` URL — so the canvas is never CORS-tainted and ``toBlob`` always
 * succeeds for codecs the browser can decode. Undecodable codecs (e.g. HEVC
 * on non-Apple) fire ``error`` / time out and the caller falls back to the
 * play-glyph placeholder.
 *
 * We seek to ``min(1s, 10% in)`` to skip black intro frames, wait for the
 * ``seeked`` event (the element is intentionally off-DOM, so the
 * compositor-driven ``requestVideoFrameCallback`` can't be relied on to
 * fire), then draw at most ``maxDimension`` px on the long side.
 *
 * Returns ``null`` if the canvas produced no blob; rejects on decode
 * failure / timeout (callers treat both as "no poster").
 */
export async function generateVideoPoster(
  file: File,
  maxDimension: number = 1024,
  quality: number = 0.82,
): Promise<VideoPosterResult | null> {
  if (!file.type.startsWith("video/")) return null;
  if (typeof document === "undefined") return null;

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    return await new Promise<VideoPosterResult | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Video poster extraction timed out"));
      }, VIDEO_POSTER_TIMEOUT_MS);

      const fail = (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error("Video decode failed"));
      };

      const capture = () => {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) {
          fail(new Error("Video has no intrinsic dimensions"));
          return;
        }
        const longest = Math.max(vw, vh);
        const scale = longest > maxDimension ? maxDimension / longest : 1;
        const tw = Math.round(vw * scale);
        const th = Math.round(vh * scale);

        const canvas = document.createElement("canvas");
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          fail(new Error("No 2D canvas context"));
          return;
        }
        ctx.imageSmoothingQuality = "high";
        try {
          ctx.drawImage(video, 0, 0, tw, th);
        } catch (err) {
          fail(err);
          return;
        }

        const durationMs =
          Number.isFinite(video.duration) && video.duration > 0
            ? Math.round(video.duration * 1000)
            : null;

        canvas.toBlob(
          (blob) => {
            clearTimeout(timer);
            resolve(blob ? { blob, width: vw, height: vh, durationMs } : null);
          },
          "image/jpeg",
          quality,
        );
      };

      video.onerror = () => {
        fail(new Error("Failed to decode video"));
      };
      // Seek on ``loadeddata`` (decoder has a frame ready), not
      // ``loadedmetadata`` — seeking too early can resolve onto an
      // undecoded/black frame. ``{ once: true }`` so the handler can't
      // double-fire.
      video.addEventListener(
        "loadeddata",
        () => {
          const d = video.duration;
          // Skip black intro frames; clamp to 1s in. Some containers report
          // a non-finite duration up front — fall back to a small nonzero
          // offset rather than frame 0 (often black).
          const target =
            Number.isFinite(d) && d > 0 ? Math.min(1, d * 0.1) : 0.1;
          const seekTo = target > 0 ? target : 0.1;

          // Already sitting on the target frame — no ``seeked`` will fire,
          // so capture what we have.
          if (Math.abs(video.currentTime - seekTo) < 0.001) {
            capture();
            return;
          }
          video.addEventListener(
            "seeked",
            () => {
              capture();
            },
            { once: true },
          );
          try {
            video.currentTime = seekTo;
          } catch (err) {
            fail(err);
          }
        },
        { once: true },
      );

      video.src = url;
    });
  } finally {
    // Detach the source so the element can be GC'd promptly (avoids the
    // documented detached-HTMLMediaElement leak) and free the object URL.
    video.removeAttribute("src");
    try {
      video.load();
    } catch {
      /* element already torn down */
    }
    URL.revokeObjectURL(url);
  }
}
