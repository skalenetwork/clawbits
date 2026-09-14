const inView = new Set<HTMLVideoElement>();
let holds = 0;
let observer: IntersectionObserver | undefined;

function sync(video: HTMLVideoElement) {
  if (
    inView.has(video) &&
    holds === 0 &&
    !document.hidden &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    video.play().catch(() => undefined);
  } else {
    video.pause();
  }
}

function syncAll() {
  inView.forEach(sync);
}

document.addEventListener("visibilitychange", syncAll);

export function autoplay(video: HTMLVideoElement) {
  const io = (observer ??= new IntersectionObserver(
    (entries) => {
      for (const { target, intersectionRatio } of entries) {
        if (!(target instanceof HTMLVideoElement)) continue;
        if (intersectionRatio >= 0.5) inView.add(target);
        else inView.delete(target);
        sync(target);
      }
    },
    { threshold: 0.5 },
  ));
  io.observe(video);
  return () => {
    io.unobserve(video);
    inView.delete(video);
  };
}

export function holdAutoplay() {
  holds += 1;
  syncAll();
  return () => {
    holds -= 1;
    syncAll();
  };
}
