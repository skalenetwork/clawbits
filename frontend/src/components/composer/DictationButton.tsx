import { useEffect, useRef, type CSSProperties } from "react";
import { Mic } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { useDictation } from "@/hooks/useDictation";
import { cn } from "@/lib/utils";

/** The auto-send countdown stays hidden this long, so words arriving steadily never show it. */
const COUNTDOWN_LEAD_MS = 600;

/** Writes the microphone's loudness (0 to 1) to `--level` on `el` each frame, outside React. */
async function meter(el: HTMLElement): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let level = 0;
  let frame = requestAnimationFrame(function tick() {
    analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
    level = Math.max(Math.min(1, rms * 8), level * 0.85);
    el.style.setProperty("--level", level.toFixed(3));
    frame = requestAnimationFrame(tick);
  });
  return () => {
    cancelAnimationFrame(frame);
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };
}

/** The composer's mic: a pill of bars that follow the voice while listening. */
export function DictationButton({
  status,
  countdown,
  onToggle,
}: Pick<ReturnType<typeof useDictation>, "status" | "countdown"> & { onToggle: () => void }) {
  const levelRef = useRef<HTMLSpanElement>(null);
  const listening = status === "listening";

  useEffect(() => {
    const el = levelRef.current;
    if (!listening || !el) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    meter(el).then((off) => {
      if (cancelled) off();
      else stop = off;
    }, () => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [listening]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => { e.preventDefault(); }}
            onClick={onToggle}
            aria-label={status === "idle" ? "Dictate" : "Stop dictation"}
            aria-pressed={status !== "idle"}
            className={cn(
              "relative grid h-7 shrink-0 place-items-center overflow-hidden rounded-full transition-all",
              listening
                ? "w-11 bg-primary/12 text-primary hover:bg-primary/18"
                : "w-7 text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
            )}
          >
            {countdown && (
              <span
                key={countdown.at}
                aria-hidden
                style={{ animationDelay: `${String(COUNTDOWN_LEAD_MS)}ms`, animationDuration: `${String(countdown.ms - COUNTDOWN_LEAD_MS)}ms` }}
                className="animate-dictation-countdown absolute inset-0 origin-left bg-primary/15"
              />
            )}
            {listening ? (
              <span ref={levelRef} aria-hidden className="relative flex h-3.5 items-center gap-[3px]">
                {[0.5, 1, 0.7, 0.35].map((k) => (
                  <span
                    key={k}
                    style={{ "--k": k } as CSSProperties}
                    className="h-full w-[3px] rounded-full bg-current [transform:scaleY(calc(0.2_+_var(--level,0)*var(--k)*0.8))]"
                  />
                ))}
              </span>
            ) : (
              <Mic className={cn("size-4", status === "starting" && "animate-pulse")}/>
            )}
          </button>
        }
      />
      <TooltipContent side="top" sideOffset={6} className="text-xs">
        {status === "idle" ? "Dictate" : "Stop dictation, or Esc to discard"}
      </TooltipContent>
    </Tooltip>
  );
}
