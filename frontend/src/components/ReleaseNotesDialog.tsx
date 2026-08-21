import { Link } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ProgressiveBlur } from "@/components/ProgressiveBlur";
import { ReleaseNotesBody } from "@/components/release-notes/ReleaseNotesBody";
import { useReleaseNotes } from "@/hooks/useReleaseNotes";
import { cn } from "@/lib/utils";

function formatDate(date: string | null): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/**
 * "What's new" modal. Self-driving via ``useReleaseNotes`` - mount once in the
 * authed layout. Frosted-glass surface like the profile menu (the panel blurs
 * what's behind it; the app itself is only dimmed, not blurred), a gradient hero
 * with the version, then spacious notes. See ``src/release-notes/``.
 */
export function ReleaseNotesDialog() {
  const { open, releases, dismiss } = useReleaseNotes();

  const latest = releases[0];
  if (!latest) return null;
  const multiple = releases.length > 1;
  const latestDate = formatDate(latest.date);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent
        showCloseButton={false}
        // No dim (a dim layer flattens the panel's see-through), but a slight
        // app-wide blur behind it; the panel itself frosts harder on top.
        overlayClassName="bg-transparent backdrop-blur-[3px] supports-[backdrop-filter]:backdrop-blur-[3px]"
        className={cn(
          "gap-4 p-4 sm:max-w-[34rem]",
          // A popover wash over the base dialog glass — still glassy, but opaque
          // enough that the page behind doesn't clutter the notes. Override both
          // the plain and the supports-[backdrop-filter] base fills.
          "bg-popover/75 supports-[backdrop-filter]:bg-popover/75",
          "ring-inset ring-foreground/[0.06]",
          "shadow-[0_18px_45px_-12px_rgba(0,0,0,0.45),0_2px_6px_-2px_rgba(0,0,0,0.25)]",
        )}
      >
        {/* Hero - the release's own artwork when ``src/release-notes/<version>.png``
            is bundled (version overlaid on a bottom scrim so it reads on any image),
            else the same colored bg + SVG pattern as the login left panel. */}
        <DialogHeader className="contents">
          <div
            className={cn(
              "relative overflow-hidden rounded-xl text-center",
              !latest.image && "bg-[url('/login-bg.png')] bg-cover bg-center",
            )}
          >
            {latest.image ? (
              <>
                {/* `object-right`, not the default centre: a hero wider than
                    2:1 gets trimmed on both sides, and these are screenshots
                    of app or OS chrome, where the subject sits right of the
                    empty background it was captured against - a centred crop
                    cuts into it. Inert for a hero that is exactly 2:1 (nothing
                    to trim). Kept global rather than per-release until a
                    left-weighted hero actually turns up; mirrored in the
                    marketing changelog's `.shot img` so both surfaces frame
                    the same file identically. */}
                <img
                  src={latest.image}
                  alt=""
                  draggable={false}
                  className="aspect-[2/1] w-full select-none object-cover object-right"
                />
                {/* Bottom scrim the version sits on: a progressive blur ramp
                    plus a short gradient to black, so the white overlay text
                    reads on any artwork. The band overscans the sides and
                    bottom (negative insets, clipped by the rounded parent) -
                    backdrop-filter samples thin out at an element's edges, so
                    without the overscan the image borders stay sharp. */}
                <ProgressiveBlur
                  side="bottom"
                  blur={8}
                  className="pointer-events-none absolute -inset-x-4 -bottom-4 top-[30%]"
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/80 to-transparent" />
              </>
            ) : (
              <div className="pointer-events-none absolute inset-0 mix-blend-overlay [background-image:url('/login-pattern.svg')] [background-size:48px_48px]" />
            )}
            <div
              className={cn(
                latest.image
                  ? "absolute inset-x-0 bottom-0 px-5 pb-4 text-white"
                  : "relative px-5 py-6 text-neutral-900",
              )}
            >
              <DialogTitle
                className={cn(
                  "justify-center font-heading text-[13px] font-semibold",
                  latest.image ? "text-white/85" : "text-neutral-900/70",
                )}
              >
                What&apos;s new{latestDate ? ` · ${latestDate}` : ""}
              </DialogTitle>
              <div className="mt-1 text-4xl font-bold tracking-tight tabular-nums">
                v{latest.version}
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-5 overflow-y-auto px-1">
          {releases.map((release, i) => {
            const date = formatDate(release.date);
            return (
              <div key={release.version} className={cn(i > 0 && "border-t border-border/60 pt-4")}>
                {multiple && (
                  <div className="mb-2 text-xs font-semibold text-muted-foreground tabular-nums">
                    v{release.version}
                    {date ? ` · ${date}` : ""}
                  </div>
                )}
                {release.title && (
                  <h3 className="mb-3 text-balance text-center text-lg font-bold tracking-tight text-foreground">
                    {release.title}
                  </h3>
                )}
                <ReleaseNotesBody content={release.body} />
              </div>
            );
          })}
        </div>

        <div className="space-y-3">
          <Button onClick={dismiss} className="w-full">Got it</Button>
          <Link
            to="/changelog"
            onClick={dismiss}
            className="block text-center text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            View all updates
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}
