import { afterEach, describe, expect, it, vi } from "vitest";
import { autoplay, holdAutoplay } from "@/components/video/autoplay";

type Entry = Pick<IntersectionObserverEntry, "target" | "intersectionRatio">;

let intersect: (entries: Entry[]) => void = () => undefined;
let reducedMotion = false;
const cleanups: (() => void)[] = [];

vi.stubGlobal(
  "IntersectionObserver",
  class {
    observe = vi.fn();
    unobserve = vi.fn();
    constructor(callback: (entries: Entry[]) => void) {
      intersect = callback;
    }
  },
);
vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  reducedMotion = false;
  vi.restoreAllMocks();
});

function mount(intersectionRatio: number) {
  const target = document.createElement("video");
  const play = vi.spyOn(target, "play").mockResolvedValue();
  const pause = vi.spyOn(target, "pause").mockReturnValue();
  cleanups.push(autoplay(target));
  intersect([{ target, intersectionRatio }]);
  return { target, play, pause };
}

describe("autoplay", () => {
  it("plays only while at least half visible", () => {
    const { target, play, pause } = mount(0.6);
    expect(play).toHaveBeenCalledOnce();
    intersect([{ target, intersectionRatio: 0.4 }]);
    expect(pause).toHaveBeenCalledOnce();
  });

  it("pauses while held and resumes on release", () => {
    const { play, pause } = mount(1);
    const release = holdAutoplay();
    expect(pause).toHaveBeenCalledOnce();
    release();
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("pauses while the page is hidden", () => {
    const { pause } = mount(1);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(pause).toHaveBeenCalledOnce();
  });

  it("stays paused with reduced motion", () => {
    reducedMotion = true;
    const { play } = mount(1);
    expect(play).not.toHaveBeenCalled();
  });
});
