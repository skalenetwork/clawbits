import confetti from "canvas-confetti";
import { prefersReducedMotion } from "./motion";

/** A short celebratory "fountain" of a single emoji, erupting from a point on
 *  screen — used when a reaction is added so the emoji sprays up out of the
 *  chip the user just tapped (à la Rainbow's wallet-connect button).
 *
 *  Built on canvas-confetti: a single shared, fixed, pointer-events-none canvas
 *  it manages itself, so there's nothing to mount or clean up here. */

// shapeFromText rasterizes the glyph to a bitmap — comparatively expensive and
// pointless to repeat, since reactions reuse the same handful of emoji. Cache
// one rasterized shape per emoji at our render scale.
const SCALAR = 2.7;
const shapeCache = new Map<string, confetti.Shape>();

function shapeFor(emoji: string): confetti.Shape {
  let shape = shapeCache.get(emoji);
  if (!shape) {
    shape = confetti.shapeFromText({ text: emoji, scalar: SCALAR });
    shapeCache.set(emoji, shape);
  }
  return shape;
}


// Fire the actual fountain from a viewport-normalised point (x/y in 0..1).
function fireBurst(emoji: string, x: number, y: number): void {
  const base: confetti.Options = {
    origin: { x, y },
    shapes: [shapeFor(emoji)],
    scalar: SCALAR,
    angle: 90, // straight up; gravity arcs them back down into a fountain
    gravity: 1.6, // pull them back down quickly so they clear the screen
    decay: 0.9, // bleed velocity a touch faster
    ticks: 90, // short lifetime — fade out fast instead of lingering
    flat: true, // emoji read better face-on than tumbling like paper confetti
    disableForReducedMotion: true,
  };

  // Two quick staggered pops give the spray some volume and a tail, rather than
  // one dense clump that vanishes at once.
  void confetti({ ...base, particleCount: 16, spread: 55, startVelocity: 30 });
  window.setTimeout(() => {
    void confetti({ ...base, particleCount: 10, spread: 80, startVelocity: 22 });
  }, 90);
}

/** Erupt a fountain of `emoji` from the centre of `origin` (typically the
 *  reaction chip just clicked). Falls back to the lower-centre of the viewport
 *  when no element is given. No-ops for empty emoji or reduced-motion users. */
export function burstEmojiFrom(emoji: string, origin?: HTMLElement | null): void {
  if (typeof window === "undefined" || !emoji || prefersReducedMotion()) return;

  // canvas-confetti's origin is normalised to the viewport (0..1), with y
  // growing downward — derive it from the chip's on-screen centre.
  const rect = origin?.getBoundingClientRect();
  const x = rect ? (rect.left + rect.width / 2) / window.innerWidth : 0.5;
  const y = rect ? (rect.top + rect.height / 2) / window.innerHeight : 0.85;
  fireBurst(emoji, x, y);
}

/** Same fountain, but anchored to an explicit viewport point (clientX/clientY)
 *  — for paths where there's no stable element to measure (e.g. a reaction
 *  picked from the emoji picker, fired from where it was anchored). */
export function burstEmojiAt(emoji: string, clientX: number, clientY: number): void {
  if (typeof window === "undefined" || !emoji || prefersReducedMotion()) return;
  fireBurst(emoji, clientX / window.innerWidth, clientY / window.innerHeight);
}
