/** How far an iMessage tail sticks past the text box, on the screen-edge side. */
export const BUBBLE_TAIL = 6;

const OUTER = 18;
const GROUPED = 6;

/**
 * One filled iMessage silhouette. The tail is part of the fill, so nothing is
 * punched out with the screen color. `width` and `height` are the text box;
 * the path's horizontal span is `width` plus the tail when this bubble is the
 * last in a run.
 */
export function bubblePath(
  width: number,
  height: number,
  own: boolean,
  groupedPrev: boolean,
  groupedNext: boolean,
): string {
  const tailed = !groupedNext;
  const tail = tailed ? BUBBLE_TAIL : 0;
  const w = width + tail;
  const h = height;
  const body = w - tail;
  const x = (value: number) => (own ? value : w - value);
  const sweep = own ? 1 : 0;
  let topLeft = Math.min(OUTER, h / 2, body / 2);
  let bottomLeft = Math.min(OUTER, h / 2, body / 2);
  let topRight = Math.min(groupedPrev ? GROUPED : OUTER, h / 2, body / 2);
  [topLeft, bottomLeft] = fit(topLeft, bottomLeft, h);
  [topLeft, topRight] = fit(topLeft, topRight, body);

  const move = (px: number, py: number) => `M ${n(x(px))} ${n(py)}`;
  const line = (px: number, py: number) => `L ${n(x(px))} ${n(py)}`;
  const curve = (
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    px: number,
    py: number,
  ) =>
    `C ${n(x(c1x))} ${n(c1y)} ${n(x(c2x))} ${n(c2y)} ${n(x(px))} ${n(py)}`;
  const arc = (radius: number, px: number, py: number) =>
    radius < 0.5
      ? line(px, py)
      : `A ${n(radius)} ${n(radius)} 0 0 ${sweep} ${n(x(px))} ${n(py)}`;

  if (!tailed) {
    let bottomRight = Math.min(GROUPED, h / 2, body / 2);
    [topRight, bottomRight] = fit(topRight, bottomRight, h);
    [bottomLeft, bottomRight] = fit(bottomLeft, bottomRight, body);
    return [
      move(topLeft, 0),
      line(body - topRight, 0),
      arc(topRight, body, topRight),
      line(body, h - bottomRight),
      arc(bottomRight, body - bottomRight, h),
      line(bottomLeft, h),
      arc(bottomLeft, 0, h - bottomLeft),
      line(0, topLeft),
      arc(topLeft, topLeft, 0),
      "Z",
    ].join(" ");
  }

  const rise = Math.min(15, Math.max(9, h * 0.42));
  topRight = Math.min(topRight, Math.max(4, h - rise));
  const neck = Math.max(topRight, h - rise);
  const tipX = w - 0.4;
  const tipY = h - 1;
  const join = Math.max(bottomLeft + 1, body - 8);
  return [
    move(topLeft, 0),
    line(body - topRight, 0),
    arc(topRight, body, topRight),
    line(body, neck),
    curve(body, h - 5, tipX, h - 4.5, tipX, tipY),
    curve(tipX - 2, h, body - 3, h, join, h),
    line(bottomLeft, h),
    arc(bottomLeft, 0, h - bottomLeft),
    line(0, topLeft),
    arc(topLeft, topLeft, 0),
    "Z",
  ].join(" ");
}

function fit(a: number, b: number, limit: number): [number, number] {
  if (limit <= 0) return [0, 0];
  if (a + b <= limit) return [a, b];
  const scale = limit / (a + b);
  return [a * scale, b * scale];
}

function n(value: number): string {
  return String(Math.round(value * 10) / 10);
}
