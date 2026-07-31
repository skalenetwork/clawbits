import { Link } from "react-router-dom";

/**
 * Floating, glassy pill header for public pages (Terms, Privacy,
 * future marketing). Fixed at the top, blurs whatever scrolls behind it.
 * Pages that use this should reserve top padding (`pt-24` / `sm:pt-28`).
 */
export function SiteHeader() {
  return (
    <header className="fixed inset-x-0 z-50 flex justify-center px-4 top-[calc(--spacing(4)+var(--titlebar-height))] sm:top-[calc(--spacing(6)+var(--titlebar-height))]">
      <div className="flex w-full max-w-3xl items-center justify-between gap-3 rounded-xl border border-foreground/10 bg-background/70 px-2 py-2 backdrop-blur-xl backdrop-saturate-150 sm:px-3 dark:border-foreground/[0.08] dark:bg-foreground/[0.05]">
        <Link
          to="/login"
          className="flex items-center gap-2 pl-2 transition-opacity hover:opacity-80"
          aria-label="Clawbits home"
        >
          <img
            src="/clawbits-long.svg"
            alt="Clawbits"
            className="h-5 w-auto opacity-90 dark:invert"
          />
        </Link>

        <nav className="flex items-center gap-1">
          <Link
            to="/login"
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground sm:px-4"
          >
            Sign up
          </Link>
          <Link
            to="/login"
            className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 sm:px-5"
          >
            Login
          </Link>
        </nav>
      </div>
    </header>
  );
}
