import { CloudUploadIcon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";

interface ChannelDropOverlayProps {
  show: boolean;
  /** Optional caption — defaults to the in-code MM_FILES limits. */
  caption?: string;
}

/**
 * Fullscreen frosted overlay shown while files are being dragged over
 * the channel viewport. Sits at z-40 (under modals/lightboxes at z-50)
 * and is ``pointer-events-none`` so the underlying drag target keeps
 * receiving ``dragover`` and ``drop`` events from the window listener.
 */
export function ChannelDropOverlay({
  show,
  caption = "Up to 5 files, 15 MB each",
}: ChannelDropOverlayProps) {
  if (!show) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-40 bg-black/40 backdrop-blur-md">
      {/* Inset glass card with a dashed border — visually distinct from
          the lightbox (solid border) so it reads as "drop zone" not
          "modal you can interact with". */}
      <div className="absolute inset-4 sm:inset-6 md:inset-10 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-white/30 bg-black/30 backdrop-blur-2xl">
        <div className="flex flex-col items-center gap-3 text-white/95">
          <div className="flex size-14 items-center justify-center rounded-full bg-white/10 backdrop-blur-md">
            <Icon icon={CloudUploadIcon} className="size-7" />
          </div>
          <span className="text-base font-medium">Drop files to upload</span>
          <span className="text-sm text-white/65">{caption}</span>
        </div>
      </div>
    </div>
  );
}
