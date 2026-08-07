import { useEffect } from "react";
import { Link } from "react-router-dom";
import { SiteHeader } from "@/components/SiteHeader";
import { ReleaseNotesBody } from "@/components/release-notes/ReleaseNotesBody";
import { RELEASES } from "@/lib/releaseNotes";
import { cn } from "@/lib/utils";

function formatDate(date: string | null): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Public changelog - the full history of "What's new" releases, newest first.
 * Reads the same bundled `RELEASES` the `ReleaseNotesDialog` does (one markdown
 * file + optional hero PNG per version under `src/release-notes/`), so new
 * releases appear here automatically. Laid out as a vertical timeline: version
 * and date pinned on the left, hero image + notes on the right. Releases without
 * a hero PNG fall back to notes only - no empty frame.
 */
export default function ChangelogPage() {
  useEffect(() => {
    const prev = document.title;
    document.title = "Changelog · Clawbits";
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <div className="min-h-svh bg-background text-foreground">
      <SiteHeader />

      <main className="mx-auto max-w-3xl px-6 pb-24 pt-24 sm:pt-28">
        <header className="space-y-3">
          {/* The eyebrow is the landing's highest-volume use of the accent
              (web/src/components/Eyebrow.astro) and the register carries over
              exactly: 14px, medium, signal. Sentence case, not uppercase - the
              marketing site has no uppercase register. */}
          <p className="text-sm font-medium text-signal">Changelog</p>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            What&apos;s new
          </h1>
        </header>

        <div className="mt-14 sm:mt-16">
          {RELEASES.length === 0 ? (
            <p className="text-sm text-muted-foreground">No releases yet.</p>
          ) : (
            RELEASES.map((release, i) => {
              const date = formatDate(release.date);
              const isLatest = i === 0;
              const isLast = i === RELEASES.length - 1;
              return (
                <section
                  key={release.version}
                  id={`v${release.version}`}
                  className="grid scroll-mt-28 grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-[7rem_1fr]"
                >
                  {/* Left rail: version + date, pinned while its notes scroll past. */}
                  <div className="sm:sticky sm:top-28 sm:self-start sm:text-right">
                    <a
                      href={`#v${release.version}`}
                      className="text-[15px] font-semibold tabular-nums text-foreground transition-colors hover:text-foreground/60"
                    >
                      v{release.version}
                    </a>
                    {date && (
                      <time
                        dateTime={release.date ?? undefined}
                        className="mt-1 block text-[13px] tabular-nums text-muted-foreground"
                      >
                        {date}
                      </time>
                    )}
                    {isLatest && (
                      <span className="mt-2 inline-flex rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] font-medium text-foreground/55">
                        Latest
                      </span>
                    )}
                  </div>

                  {/* Spine + content. The node dot sits centered on the spine; the
                      bottom padding both spaces releases apart and extends the spine
                      through the gap - dropped on the last release so it doesn't
                      trail into the footer. */}
                  <div
                    className={cn(
                      "relative border-l border-border/60 pl-7 sm:pl-8",
                      isLast ? "pb-0" : "pb-20",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "absolute -left-[5px] top-1.5 rounded-full",
                        isLatest
                          ? "size-2.5 bg-foreground"
                          : "size-2 border-[1.5px] border-muted-foreground/50 bg-background",
                      )}
                    />

                    {release.image && (
                      <div className="mb-5 overflow-hidden rounded-2xl bg-muted ring-1 ring-border/60">
                        <img
                          src={release.image}
                          alt={
                            release.title
                              ? `${release.title} - Clawbits v${release.version}`
                              : `Clawbits v${release.version}`
                          }
                          loading="lazy"
                          decoding="async"
                          draggable={false}
                          className="aspect-[2/1] w-full select-none object-cover"
                        />
                      </div>
                    )}

                    {release.title && (
                      <h2 className="mb-3 text-lg font-semibold tracking-tight text-foreground">
                        {release.title}
                      </h2>
                    )}

                    <ReleaseNotesBody content={release.body} />
                  </div>
                </section>
              );
            })
          )}
        </div>

        <hr className="my-16 border-border/60" />

        <footer className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>
            © {new Date().getFullYear()} SKALE Labs - Portugal
          </span>
          <div className="flex gap-5">
            <Link to="/terms" className="hover:text-foreground">
              Terms
            </Link>
            <Link to="/privacy" className="hover:text-foreground">
              Privacy
            </Link>
            <Link to="/login" className="hover:text-foreground">
              Back to app
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
}
