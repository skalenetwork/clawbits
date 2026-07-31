import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight01Icon, Cancel01Icon, ToolsIcon } from "@hugeicons/core-free-icons";
import { useAuth } from "../context/AuthContext";
import { errMsg, toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/Icon";
import { UserAvatar } from "@/components/UserAvatar";
import { UnicodeSpinner } from "@/components/UnicodeSpinner";

const RECENT_KEY = "fc_dev_recent_emails";
const HIDDEN_KEY = "fc_dev_panel_hidden";
const MAX_RECENT = 4;
// Default personas to suggest before the user has any history.
const DEFAULT_PERSONAS = ["alice@example.com", "bob@example.com"];

const CHIP_AVATAR_SIZE = 22;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string").slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function saveRecent(email: string): void {
  try {
    const current = loadRecent();
    const next = [email, ...current.filter((e) => e !== email)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable — ignore */
  }
}

/** "alice@x.com" → "Alice"; "stan-the-man@x.com" → "Stan The Man". */
function personaName(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Dev sign-in panel — local-only. Renders only when the backend reports
 * `CLAWBITS_DEV_AUTH=1` in a dev-marked environment. The actual gate
 * lives in `clawbits/fastapi/dev_auth.py`; this component is purely UX.
 */
export function DevSignInPanel() {
  const { signInDev } = useAuth();
  const navigate = useNavigate();
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(HIDDEN_KEY) === "1"; } catch { return false; }
  });
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  // Pre-fill once with the most recent email so devs can edit a single
  // character to switch personas. After mount the field is fully under
  // user control — clearing it stays cleared.
  const [customEmail, setCustomEmail] = useState(() => loadRecent()[0] ?? "");
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  // Suggestion chips: recent emails first, padded with default personas.
  // De-duped, original order preserved.
  const chips = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of [...recent, ...DEFAULT_PERSONAS]) {
      if (seen.has(e)) continue;
      seen.add(e);
      out.push(e);
      if (out.length >= MAX_RECENT) break;
    }
    return out;
  }, [recent]);

  const doSignIn = async (email: string) => {
    if (pendingEmail) return;
    setPendingEmail(email);
    try {
      await signInDev(email);
      saveRecent(email);
      setRecent(loadRecent());
      void navigate("/home");
    } catch (err: unknown) {
      toast.error(errMsg(err, "Dev sign-in failed"));
      setPendingEmail(null);
    }
  };

  const handleCustomSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!customEmail) return;
    void doSignIn(customEmail);
  };

  const handleHide = () => {
    try { localStorage.setItem(HIDDEN_KEY, "1"); } catch { /* ignore */ }
    setHidden(true);
  };

  if (hidden) return null;

  return (
    <div className="mt-8 rounded-xl border border-dashed border-amber-500/40 bg-amber-500/[0.04] p-4 shadow-sm">
      {/* Header row: tools icon + title on the left, DEV badge on the right */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid size-6 place-items-center rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <Icon icon={ToolsIcon} className="size-3.5" />
          </span>
          <span className="text-sm font-semibold text-amber-700 dark:text-amber-300">
            Dev sign-in
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">
            DEV
          </span>
          <button
            type="button"
            onClick={handleHide}
            aria-label="Hide dev sign-in panel"
            title="Hide dev sign-in panel"
            className="grid size-5 place-items-center rounded-md text-amber-700/70 transition-colors hover:bg-amber-500/15 hover:text-amber-700 dark:text-amber-400/70 dark:hover:text-amber-300"
          >
            <Icon icon={Cancel01Icon} className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Persona quick-chips — same UserAvatar the user will see post-login */}
      <div className="mb-4 flex flex-wrap gap-2.5">
        {chips.map((email) => {
          const isPending = pendingEmail === email;
          return (
            <button
              key={email}
              type="button"
              disabled={Boolean(pendingEmail)}
              onClick={() => { void doSignIn(email); }}
              title={email}
              className={`group inline-flex items-center gap-2.5 rounded-full border border-border/80 bg-background/80 py-1 pl-1 pr-4 text-sm font-medium text-foreground/85 shadow-xs ring-1 ring-transparent transition-all hover:-translate-y-px hover:border-amber-500/50 hover:bg-amber-500/[0.06] hover:text-foreground hover:shadow-sm hover:ring-amber-500/15 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-xs ${
                isPending ? "border-amber-500/60 bg-amber-500/[0.08] ring-amber-500/20" : ""
              }`}
            >
              <span className="relative inline-flex shrink-0">
                <UserAvatar name={email} size={CHIP_AVATAR_SIZE} className="rounded-full" />
                {isPending && (
                  <span className="absolute inset-0 grid place-items-center rounded-full bg-background/80 text-foreground/80">
                    <UnicodeSpinner className="text-[11px]" />
                  </span>
                )}
              </span>
              <span className="leading-tight tracking-tight">{personaName(email)}</span>
            </button>
          );
        })}
      </div>

      {/* Custom email row — input + arrow button on one line */}
      <form onSubmit={handleCustomSubmit} className="flex gap-2" noValidate>
        <Input
          type="email"
          required
          autoComplete="email"
          value={customEmail}
          onChange={(e) => { setCustomEmail(e.target.value); }}
          placeholder="custom@email.dev"
          disabled={Boolean(pendingEmail)}
          className="flex-1"
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={Boolean(pendingEmail) || !customEmail}
          aria-label="Sign in as this email"
          className="shrink-0"
        >
          {pendingEmail === customEmail ? (
            <UnicodeSpinner />
          ) : (
            <Icon icon={ArrowRight01Icon} className="size-4" />
          )}
        </Button>
      </form>
    </div>
  );
}
