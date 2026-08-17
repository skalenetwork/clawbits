/** Shared presentational primitives for the "Add agent" wizard (components
 *  only — constants/prompt builders live in ./prompts.ts). */
import {
    Copy01Icon as Copy,
    Tick01Icon as Check,
} from "@hugeicons/core-free-icons";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Icon} from "@/components/Icon";
import {cn} from "@/lib/utils";

export {AddEnvRowButton, EnvVarRow} from "@/components/reef/envRows";

/** A monochrome SVG silhouette painted with the CURRENT text colour (CSS mask,
 *  not `<img>`). Use this for single-colour glyphs — an `<img>` would freeze them
 *  at the file's own fill and go invisible against a dark surface. Brand rasters
 *  (openclaw.png / ironclaw.webp) stay plain `<img>`; they carry their own colour. */
export function MaskIcon({src, className}: {src: string; className?: string}) {
    return (
        <span
            aria-hidden="true"
            className={cn("inline-block shrink-0 bg-current", className)}
            style={{
                maskImage: `url(${src})`,
                maskRepeat: "no-repeat",
                maskPosition: "center",
                maskSize: "contain",
            }}
        />
    );
}

/** One of the wizard's big option cards: icon-led, one-line description max,
 *  selection = ring + corner check. The WHOLE card is the click target.
 *  `tile` puts the icon on its own tinted app-icon tile (the per-card accent
 *  that keeps sibling cards visually distinct); plain `icon` renders bare. */
export function OptionCard({
    icon,
    tile,
    title,
    line,
    trailing,
    selected,
    disabled,
    onSelect,
    children,
    className,
}: {
    icon: React.ReactNode;
    /** CSS background for the icon tile; omit for a bare icon. */
    tile?: string;
    title: string;
    line?: React.ReactNode;
    /** Corner slot (e.g. a health dot). The selection check replaces it. */
    trailing?: React.ReactNode;
    selected: boolean;
    disabled?: boolean;
    onSelect: () => void;
    /** Extra content revealed inside the card (e.g. the token field). */
    children?: React.ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "relative flex flex-col gap-3 rounded-2xl border p-4 text-left transition duration-200",
                selected
                    ? "border-foreground/40 bg-foreground/[0.05]"
                    : "border-border/50 bg-foreground/[0.02]",
                !disabled && !selected && "hover:border-foreground/25 hover:bg-foreground/[0.04]",
                // Slight press-in — the whole card scales because :active propagates
                // from the stretched button to this ancestor.
                !disabled && "active:scale-[0.98]",
                disabled && "opacity-50",
                className,
            )}
        >
            {/* One gap-3 column: icon tile, name, description — evenly spaced. */}
            <button
                type="button"
                disabled={disabled}
                aria-pressed={selected}
                onClick={onSelect}
                className={cn(
                    "flex w-full flex-col items-start gap-3 text-left disabled:cursor-not-allowed",
                    // Stretched hit target: the ::after covers the WHOLE card so a
                    // click anywhere (incl. the padding near the border) selects.
                    // Skipped when disabled so an embedded link (e.g. "connect
                    // one") stays clickable.
                    !disabled && "after:absolute after:inset-0 after:content-['']",
                )}
            >
                {tile ? (
                    <span
                        className="flex size-13 items-center justify-center rounded-2xl text-white ring-1 ring-white/10 [&_svg]:size-7 [&_img]:size-8"
                        style={{background: tile}}
                    >
                        {icon}
                    </span>
                ) : (
                    <span className="flex size-13 items-center justify-center text-foreground/90 [&_svg]:size-11 [&_img]:size-11">
                        {icon}
                    </span>
                )}
                <span className="text-lg font-semibold leading-none">{title}</span>
                {line != null && <span className="text-[13px] leading-snug text-muted-foreground">{line}</span>}
            </button>
            {/* Corner slot — visual only, so it never blocks the stretched target. */}
            <span className="pointer-events-none absolute top-3 right-3">
                {selected ? (
                    <span className="flex size-5 animate-in items-center justify-center rounded-full bg-foreground text-background zoom-in-50 duration-150">
                        <Icon icon={Check} className="size-3"/>
                    </span>
                ) : (
                    trailing
                )}
            </span>
            {/* Revealed extras (token field, image select) sit ABOVE the stretched
                target so they stay independently interactive. */}
            {children && <div className="relative z-10">{children}</div>}
        </div>
    );
}

export function IconField({
    icon,
    ...props
}: {icon: React.ComponentProps<typeof Icon>["icon"]} & React.ComponentProps<typeof Input>) {
    return (
        <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground">
                <Icon icon={icon} className="size-[18px]"/>
            </span>
            <Input className="h-12 pl-11 text-base" autoComplete="off" {...props}/>
        </div>
    );
}

/** One-time access-password reveal — its own focused beat before the card.
 *  Reef mints the secret at creation and can never recompute it, so the finale
 *  waits here until the owner has taken it. Deliberately visual and terse: a
 *  key tile, the secret (tap to copy), one action. */
export function AccessPasswordScreen({
    password,
    copied,
    onCopy,
    onContinue,
}: {
    /** null while the Reef is still minting it — the screen shows a spinner. */
    password: string | null;
    copied: boolean;
    onCopy: () => void;
    onContinue: () => void;
}) {
    return (
        <div className="flex w-full animate-in flex-col gap-4 py-1 fade-in duration-300">
            <div className="flex flex-col gap-1 text-center">
                <h3 className="text-xl font-semibold tracking-tight">Save your access password</h3>
                <p className="text-[13px] text-muted-foreground">Unlocks the Control UI &amp; terminal.</p>
            </div>

            {/* The Control UI this unlocks, shown clean. */}
            <div className="w-full overflow-hidden rounded-2xl border border-border/50 bg-muted">
                <img
                    src="/openclaw-ui.webp"
                    alt=""
                    draggable={false}
                    className="aspect-[20/9] w-full select-none object-cover"
                />
            </div>

            {/* The one-time secret, in its own block below the image. ONE fixed-
                height box holds both states (min-h sized to fit the password on
                one or two lines), so the placeholder and the final password are
                exactly the same size - the card never jumps when it lands. */}
            <div className="flex min-h-[68px] w-full items-center justify-center rounded-2xl border border-border/70 bg-foreground/[0.03] px-6 text-center">
                {password ? (
                    <code className="break-all font-mono text-xl font-semibold tracking-wide select-all">
                        {password}
                    </code>
                ) : (
                    <span className="flex items-center gap-2.5 text-xl font-medium text-muted-foreground">
                        <span className="size-5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"/>
                        Generating your password…
                    </span>
                )}
            </div>

            <Button
                disabled={!password}
                onClick={() => { if (!copied) onCopy(); onContinue(); }}
                className="h-12 w-full gap-2 text-base"
            >
                {password ? (
                    <>
                        <Icon icon={copied ? Check : Copy} className="size-4"/>
                        {copied ? "Continue" : "Copy & continue"}
                    </>
                ) : (
                    "Creating your agent…"
                )}
            </Button>
        </div>
    );
}
