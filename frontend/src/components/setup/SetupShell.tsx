/** The frame every full-screen setup flow shares: an edge-to-edge stage, one
 *  centred panel, and a stepper whose answered steps wear their mark and value. */
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { Copy01Icon, Tick02Icon, ViewIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { Squircle, SquircleDefs } from "@/components/home/tiles";
import { cn } from "@/lib/utils";

export interface SetupStep {
  /** Native asset under /public, worn once the step is answered. */
  icon: string;
  value?: string | null;
}

interface SetupShellProps {
  steps: SetupStep[];
  /** Index of the step being answered now. */
  at: number;
  onExit: () => void;
  /** Esc presses Exit here, so the button wears the key chip. */
  escExits: boolean;
  /** What leaving now would lose; when set, leaving asks first. */
  unsaved?: string | null;
  children: ReactNode;
}

export function SetupShell({ steps, at, onExit, escExits, unsaved, children }: SetupShellProps) {
  const [confirming, setConfirming] = useState(false);
  const leave = () => {
    if (unsaved) setConfirming(true);
    else onExit();
  };
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing || e.repeat) return;
    const handled = confirming
      ? e.key === "Escape" || e.key === "Enter" || /^[1-9]$/.test(e.key)
      : e.key === "Escape" && escExits;
    if (!handled) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!confirming) leave();
    else if (e.key === "Escape") setConfirming(false);
    else if (e.key === "Enter") onExit();
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center bg-background px-4 py-20">
      <SquircleDefs />

      <div className="absolute inset-x-0 top-5 flex items-center justify-center gap-1.5">
        {steps.map((s, i) => {
          const done = Boolean(s.value);
          return (
            <div key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="h-0.5 w-3.5 rounded-full bg-foreground/15" />}
              <div
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-xl px-1 transition-colors duration-300",
                  done && "bg-foreground/5 pr-2.5",
                )}
              >
                {done ? (
                  // Cropped, not scaled: the box stays 22px so the row never
                  // shifts, and the oversized asset reads larger than its own
                  // padding would allow.
                  <span className="relative size-[22px] shrink-0 overflow-hidden rounded-md">
                    <img
                      src={s.icon}
                      alt=""
                      className="absolute top-1/2 left-1/2 size-[23px] max-w-none -translate-x-1/2 -translate-y-1/2"
                    />
                  </span>
                ) : (
                  // Numbered only where you are: a row of blanks says how far
                  // along you are without saying which step is asking.
                  <span
                    className={cn(
                      "grid size-[22px] place-items-center rounded-md text-[11px] font-semibold transition-colors duration-300",
                      i === at
                        ? "bg-foreground/20 text-foreground/80"
                        : "bg-foreground/10 text-transparent",
                    )}
                  >
                    {i + 1}
                  </span>
                )}
                <span
                  className={cn(
                    "max-w-0 overflow-hidden text-[13px] font-medium whitespace-nowrap opacity-0 transition-[max-width,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                    done && "max-w-48 opacity-100",
                  )}
                >
                  {s.value}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={leave}
        className={cn(
          "absolute top-5 right-5 flex h-8 items-center gap-2 rounded-lg",
          escExits ? "pl-2.5 pr-1.5" : "px-2.5",
          "bg-foreground/6 text-[13px] font-medium text-muted-foreground transition-colors duration-200",
          "hover:bg-foreground/10 hover:text-foreground",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        )}
      >
        Exit
        {escExits && (
          <span aria-hidden="true" className="grid h-5 min-w-5 place-items-center rounded-md bg-foreground/10 px-1 text-[11px]">
            Esc
          </span>
        )}
      </button>

      {confirming ? (
        <SetupPanel title="Leave setup?" line={unsaved ?? undefined}>
          <div className="flex w-full gap-2">
            <SetupButton
              variant="ghost"
              chip="Esc"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep going
            </SetupButton>
            <SetupButton chip="Enter" onClick={onExit}>
              Leave
            </SetupButton>
          </div>
        </SetupPanel>
      ) : (
        children
      )}
    </div>
  );
}

/** One screen: a mark, a title, one line, then whatever it asks for. */
export function SetupPanel({
  icon,
  title,
  line,
  children,
}: {
  icon?: ReactNode;
  title: string;
  line?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex w-full max-w-[460px] animate-in flex-col items-start gap-6 text-left duration-400 fade-in slide-in-from-bottom-2 ease-out motion-reduce:animate-none">
      {icon}
      <h1 className="text-[30px] leading-[1.15] font-semibold tracking-[-0.03em] text-balance">
        {title}
      </h1>
      {/* Full panel width, not a reading measure: a 38ch cap split one-sentence lines in two. */}
      {line && (
        <p className="text-[15px] leading-relaxed text-balance text-muted-foreground">
          {line}
        </p>
      )}
      {children}
    </div>
  );
}

/** A native setup asset at hero size: it ships its own squircle, so no clip
 *  and no glass. */
export function SetupMark({ src, size = 64 }: { src: string; size?: number }) {
  return <img src={src} alt="" width={size} height={size} style={{ width: size, height: size }} />;
}

/** A field with its mark inset on the left. The icon says what kind of thing,
 *  the placeholder says the shape, so neither needs a label. */
export function SetupField({
  icon,
  value,
  onChange,
  placeholder,
  secret,
  autoFocus,
  note,
  more,
  tone = "muted",
}: {
  icon: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** Masked, with a reveal toggle. */
  secret?: boolean;
  autoFocus?: boolean;
  /** How the field answers back: what a pasted URL was understood as, or why
   *  it was not accepted. Press it for `more`. */
  note: string;
  /** Short lines, not prose: read half-way through a task. */
  more: string[];
  tone?: "muted" | "bad";
}) {
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full">
      <div className="relative">
        <Squircle size={32} glass={false} className="absolute top-1/2 left-3 -translate-y-1/2">
          <img src={icon} alt="" className="size-8" />
        </Squircle>
        <input
          type={secret && !shown ? "password" : "text"}
          value={value}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          className={cn(
            "h-[58px] w-full rounded-2xl border bg-card pl-[3.4rem] text-[16px] text-foreground",
            "outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-foreground/35",
            secret ? "pr-12" : "pr-4",
            tone === "bad" ? "border-destructive/60" : "border-border",
          )}
        />
        {secret && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={shown ? "Hide token" : "Show token"}
            onClick={() => {
              setShown((v) => !v);
            }}
            className="absolute top-1/2 right-2.5 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground transition-colors hover:text-foreground"
          >
            <Icon icon={shown ? ViewOffSlashIcon : ViewIcon} className="size-[18px]" />
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className={cn(
          "mt-2 px-1 text-left text-[13px] transition-colors",
          tone === "bad" ? "text-destructive" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {note}
      </button>
      {/* The sidebar's 0fr to 1fr disclosure, the one reliable way to animate
          to a content height. */}
      <div className="disclosure" data-open={open}>
        <div className="disclosure-inner">
          <ul className="list-disc space-y-1 pt-2 pr-1 pl-5 text-left text-[13px] leading-relaxed text-muted-foreground marker:text-muted-foreground/45">
            {more.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * The setup button: full width, because on a one-decision screen there is only
 * ever one thing to press, with a key chip on the right so the keyboard route
 * is visible rather than folklore.
 *
 * Deliberately local to setup rather than a new `ui/button` variant: the app's
 * Button is on ~200 call sites and this treatment is still being tried.
 */
export function SetupButton({
  children,
  onClick,
  variant = "primary",
  disabled,
  type = "button",
  chip,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  /** Key hint docked right: "Enter", "Esc". */
  chip?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        // The right inset is the chip's berth. Without a chip it is dead
        // space that wraps a longer label onto a second line.
        "relative flex h-13 w-full items-center justify-start rounded-2xl pl-5",
        chip ? "pr-16" : "pr-5",
        "text-[15px] font-semibold",
        "transition-[background-color,color,transform] duration-250 ease-[cubic-bezier(0.33,1,0.68,1)]",
        "active:scale-[0.99] motion-reduce:active:scale-100",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:pointer-events-none disabled:opacity-40",
        variant === "primary"
          ? "bg-foreground text-background hover:bg-foreground/90"
          : "bg-foreground/6 text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
      )}
    >
      {children}
      {chip && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute right-2.5 grid h-7 min-w-7 place-items-center rounded-[9px] px-2",
            "text-[13px] font-medium",
            variant === "primary"
              ? "bg-background/15 text-background/75"
              : "bg-foreground/12 text-muted-foreground",
          )}
        >
          {chip}
        </span>
      )}
    </button>
  );
}

/** Signals in the order they arrive. They lag each other (a host's status file
 *  trails the agent's own join), so a later tick implies every earlier one and
 *  the first open row is the one being waited on. */
export function Checks({ items }: { items: { label: string; done: boolean }[] }) {
  const reached = items.findLastIndex((c) => c.done);
  return (
    <div className="w-full text-[14px] text-muted-foreground">
      {items.map(({ label }, i) => (
        <div key={label} className="flex items-center gap-2.5 py-1.5">
          {i <= reached ? (
            <span className="grid size-4 place-items-center rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">
              <Icon icon={Tick02Icon} className="size-2.5" strokeWidth={4} />
            </span>
          ) : i === reached + 1 ? (
            <span className="size-4 animate-spin rounded-full border-2 border-foreground/10 border-t-muted-foreground motion-reduce:animate-none" />
          ) : (
            <span className="size-4 rounded-full bg-foreground/8" />
          )}
          <span className={i <= reached ? "text-foreground" : ""}>{label}</span>
        </div>
      ))}
    </div>
  );
}

/** Something to paste on another machine, with its own copy button. Wrapped
 *  rather than scrolled sideways: in a `curl | sh` the piped URL is the one
 *  thing nobody should have to scroll to read. A long prompt scrolls down. */
export function CommandBlock({ code, copy = true }: { code: string; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-code-border bg-code text-left">
      {copy && (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 1600);
            });
          }}
          className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <Icon icon={copied ? Tick02Icon : Copy01Icon} className="size-3" />
          {copied ? "Copied" : "Copy"}
        </button>
      )}
      <pre className={cn("max-h-72 overflow-y-auto px-4 py-3.5 font-mono text-[12.5px] leading-[1.8] [overflow-wrap:anywhere] whitespace-pre-wrap", copy && "pr-16")}>
        {code}
      </pre>
    </div>
  );
}

/** One value copied bare, with nothing around it: the whole block is the button. */
export function CopyField({ label, value, onCopy }: { label: string; value: string; onCopy?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={value}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          onCopy?.();
          setTimeout(() => {
            setCopied(false);
          }, 1600);
        });
      }}
      className="group flex w-full min-w-0 flex-col gap-0.5 rounded-xl border border-code-border bg-code px-3 py-2 text-left transition-colors hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="flex items-center justify-between gap-2 text-[12px] text-muted-foreground">
        {label}
        <span className="inline-flex items-center gap-1 group-hover:text-foreground">
          <Icon icon={copied ? Tick02Icon : Copy01Icon} className="size-3" />
          {copied ? "Copied" : "Copy"}
        </span>
      </span>
      <span className="truncate font-mono text-[12.5px]">{value}</span>
    </button>
  );
}
