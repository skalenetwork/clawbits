import { useEffect, useState } from "react";
import spinners, { type BrailleSpinnerName } from "unicode-animations";

/**
 * Animated braille unicode spinner — a thin React wrapper around the
 * frame tables exported by `unicode-animations`. Each frame is a short
 * string of braille glyphs; we tick through them at the interval the
 * package suggests for the chosen animation.
 *
 * Render inline alongside text (the glyphs are monospace-sized).
 */
export function UnicodeSpinner({
  name = "braille",
  className,
  ariaLabel,
}: {
  name?: BrailleSpinnerName;
  className?: string;
  ariaLabel?: string;
}) {
  const spinner = spinners[name];
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const handle = window.setInterval(
      () => { setFrameIndex((i) => (i + 1) % spinner.frames.length); },
      spinner.interval,
    );
    return () => { window.clearInterval(handle); };
  }, [spinner]);

  return (
    <span
      className={className}
      style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}
      aria-label={ariaLabel ?? "loading"}
      role="img"
    >
      {spinner.frames[frameIndex]}
    </span>
  );
}
