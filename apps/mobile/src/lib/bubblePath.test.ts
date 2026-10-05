import { describe, expect, test } from "bun:test";
import { BUBBLE_TAIL, bubblePath } from "./bubblePath";

function points(path: string): [number, number][] {
  const tokens = path.split(/\s+/);
  const found: [number, number][] = [];
  for (let i = 0; i < tokens.length; i++) {
    const command = tokens[i];
    if (command === "M" || command === "L") {
      found.push([Number(tokens[++i]), Number(tokens[++i])]);
    } else if (command === "C") {
      found.push([Number(tokens[++i]), Number(tokens[++i])]);
      found.push([Number(tokens[++i]), Number(tokens[++i])]);
      found.push([Number(tokens[++i]), Number(tokens[++i])]);
    } else if (command === "A") {
      i += 5;
      found.push([Number(tokens[i + 1]), Number(tokens[i + 2])]);
      i += 2;
    }
  }
  return found;
}

function bounds(path: string) {
  const pts = points(path);
  return {
    minX: Math.min(...pts.map((point) => point[0])),
    maxX: Math.max(...pts.map((point) => point[0])),
    minY: Math.min(...pts.map((point) => point[1])),
    maxY: Math.max(...pts.map((point) => point[1])),
  };
}

describe("bubblePath", () => {
  test("outgoing tail sticks past the text box and stays inside the silhouette", () => {
    const width = 120;
    const height = 36;
    const path = bubblePath(width, height, true, false, false);
    const box = bounds(path);
    expect(path.endsWith("Z")).toBe(true);
    expect(box.maxX).toBeGreaterThan(width);
    expect(box.maxX).toBeLessThanOrEqual(width + BUBBLE_TAIL);
    expect(box.minX).toBeGreaterThanOrEqual(0);
    expect(box.minY).toBeGreaterThanOrEqual(0);
    expect(box.maxY).toBeLessThanOrEqual(height);
  });

  test("a following bubble from the same person has no tail", () => {
    const width = 80;
    const path = bubblePath(width, 36, true, true, true);
    const box = bounds(path);
    expect(box.maxX).toBeLessThanOrEqual(width + 0.1);
    expect(box.minX).toBeGreaterThanOrEqual(-0.1);
  });

  test("incoming tail sticks out the other side", () => {
    const width = 90;
    const height = 48;
    const path = bubblePath(width, height, false, false, false);
    const box = bounds(path);
    expect(box.minX).toBeLessThan(BUBBLE_TAIL);
    expect(box.minX).toBeGreaterThanOrEqual(0);
    expect(box.maxX).toBeLessThanOrEqual(width + BUBBLE_TAIL);
    expect(box.maxY).toBeLessThanOrEqual(height);
  });

  test("a short bubble keeps every point inside its box", () => {
    for (const height of [20, 36, 120]) {
      const path = bubblePath(48, height, true, false, true);
      const box = bounds(path);
      expect(box.minX).toBeGreaterThanOrEqual(-0.1);
      expect(box.maxX).toBeLessThanOrEqual(48.1);
      expect(box.minY).toBeGreaterThanOrEqual(-0.1);
      expect(box.maxY).toBeLessThanOrEqual(height + 0.1);
    }
  });
});
