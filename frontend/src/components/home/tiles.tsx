/**
 * The home tile system: glyph, label, value, on a two-width grid.
 *
 * A `rounded-*` corner is a circular arc and reads visibly rounder at the
 * tangent, which is what makes an icon look foreign next to a native one. So
 * the squircle is a real superellipse (|x|^n + |y|^n = 1 at n = 5, the
 * continuous-corner curve Apple's icon shape approximates), generated once
 * into a `clipPath` in objectBoundingBox units so one definition fits any size.
 */
import {useEffect, useRef, type CSSProperties, type ReactNode} from "react";
import {Link, useNavigate} from "react-router-dom";
import {cn} from "@/lib/utils";

const CLIP_ID = "cb-squircle";
const RIM_ID = "cb-squircle-rim";

function squirclePath(n = 5, steps = 160): string {
    const pts: string[] = [];
    for (let i = 0; i < steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        const c = Math.cos(t);
        const s = Math.sin(t);
        const x = 0.5 + 0.5 * Math.sign(c) * Math.abs(c) ** (2 / n);
        const y = 0.5 + 0.5 * Math.sign(s) * Math.abs(s) ** (2 / n);
        pts.push(`${x.toFixed(5)},${y.toFixed(5)}`);
    }
    return `M${pts.join("L")}Z`;
}

const SQUIRCLE_D = squirclePath();

/** Mount once per page that uses `Squircle`. Renders nothing visible. */
export function SquircleDefs() {
    return (
        <svg
            aria-hidden="true"
            className="pointer-events-none absolute size-0 overflow-hidden"
        >
            <defs>
                <clipPath id={CLIP_ID} clipPathUnits="objectBoundingBox">
                    <path d={SQUIRCLE_D} />
                </clipPath>
                <linearGradient id={RIM_ID} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
                    <stop offset="0.34" stopColor="#fff" stopOpacity="0.12" />
                    <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
                    <stop offset="1" stopColor="#000" stopOpacity="0.16" />
                </linearGradient>
            </defs>
        </svg>
    );
}

const DOME =
    "radial-gradient(116% 74% at 50% -16%, oklch(1 0 0 / 0.30), oklch(1 0 0 / 0.05) 46%, transparent 66%)," +
    "linear-gradient(180deg, oklch(1 0 0 / 0.09), transparent 52%)";

interface SquircleProps {
    size?: number;
    /** Off for a native icon asset: it carries its own depth, and our sheen
     *  stacked on top of that reads as a smudge. */
    glass?: boolean;
    className?: string;
    style?: CSSProperties;
    children: ReactNode;
}

export function Squircle({
    size = 42,
    glass = true,
    className,
    style,
    children,
}: SquircleProps) {
    return (
        <span
            className={cn("relative grid shrink-0 place-items-center", className)}
            style={{
                width: size,
                height: size,
                clipPath: `url(#${CLIP_ID})`,
                ...style,
            }}
        >
            {children}
            {glass && (
                <>
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0"
                        style={{background: DOME}}
                    />
                    {/* The stroke is centred on the path, so the clip keeps its
                        inner half and the rim curves through the corners: an
                        inset box-shadow would follow border-radius (zero here)
                        and square them off. */}
                    <svg
                        aria-hidden="true"
                        viewBox="0 0 1 1"
                        preserveAspectRatio="none"
                        className="pointer-events-none absolute inset-0 size-full overflow-visible"
                    >
                        <path
                            d={SQUIRCLE_D}
                            fill="none"
                            stroke={`url(#${RIM_ID})`}
                            strokeWidth="2"
                            vectorEffect="non-scaling-stroke"
                        />
                    </svg>
                </>
            )}
        </span>
    );
}

const TILE_CLASS =
    "group flex min-h-16 min-w-0 items-center gap-3 rounded-[18px] border border-border/60 bg-card " +
    "px-3 py-2 text-left shadow-(--tile-shadow) transition-[box-shadow,transform,border-color] " +
    "duration-300 ease-[cubic-bezier(0.33,1,0.68,1)] hover:border-border " +
    "hover:shadow-(--tile-shadow-hover) active:scale-[0.99] focus-visible:outline-2 " +
    "focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Keycap chrome: a real key in the command tile (`<kbd>`), a decorative hint
 *  elsewhere (`<span>`). Shared so the two never drift apart. */
export const KEYCAP_CLASS =
    "grid h-8 min-w-8 place-items-center rounded-[10px] border border-border " +
    "bg-linear-to-b from-card to-background px-2 font-sans text-[15.5px] font-medium " +
    "text-muted-foreground transition-colors group-hover:text-foreground";

/** Fires the tile on an unmodified digit press. The rail already owns
 *  Cmd-number for pinned chats, so plain digits are free. Stays out of the way
 *  of anything that owns the keyboard, so it can never eat a real shortcut. */
function useDigitShortcut(digit: number | undefined, run: () => void) {
    const latest = useRef(run);
    useEffect(() => {
        latest.current = run;
    });

    useEffect(() => {
        if (digit === undefined) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
            if (e.key !== String(digit)) return;
            const el = e.target as HTMLElement | null;
            if (el?.isContentEditable) return;
            if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
            // The wizard keeps its dialog mounted so a dirty draft survives, so
            // only a rendered one owns keys.
            const dialogs = document.querySelectorAll('[role="dialog"],[role="alertdialog"]');
            if ([...dialogs].some((d) => d.getBoundingClientRect().width > 0)) return;
            e.preventDefault();
            latest.current();
        };
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("keydown", onKey);
        };
    }, [digit]);
}

interface HomeTileProps {
    glyph: ReactNode;
    label: string;
    value: string;
    to?: string;
    onClick?: () => void;
    trailing?: ReactNode;
    shortcut?: number;
    className?: string;
}

export function HomeTile({
    glyph,
    label,
    value,
    to,
    onClick,
    trailing,
    shortcut,
    className,
}: HomeTileProps) {
    const navigate = useNavigate();
    const actionable = Boolean(to || onClick);
    const digit = actionable ? shortcut : undefined;
    useDigitShortcut(digit, () => {
        if (to) void navigate(to);
        else onClick?.();
    });

    const body = (
        <>
            <span className="relative shrink-0">{glyph}</span>
            <span className="flex min-w-0 flex-col gap-[3px]">
                <span className="truncate text-[13px] leading-[1.15] text-muted-foreground">
                    {label}
                </span>
                <span className="truncate text-[17px] font-medium leading-[1.15] tracking-[-0.015em] tabular-nums">
                    {value}
                </span>
            </span>
            {(trailing || digit !== undefined) && (
                <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
                    {trailing}
                    {digit !== undefined && (
                        <span className={KEYCAP_CLASS} aria-hidden="true">
                            {digit}
                        </span>
                    )}
                </span>
            )}
        </>
    );

    if (to) {
        return (
            <Link to={to} className={cn(TILE_CLASS, className)}>
                {body}
            </Link>
        );
    }
    if (onClick) {
        return (
            <button
                type="button"
                onClick={onClick}
                className={cn(TILE_CLASS, className)}
            >
                {body}
            </button>
        );
    }
    // A tile that only reports is a div, not a button that lies about being
    // actionable.
    return <div className={cn(TILE_CLASS, "cursor-default", className)}>{body}</div>;
}
