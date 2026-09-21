import {useEffect, useState, type ReactNode} from "react";
import {Link, useNavigate} from "react-router-dom";
import {Tooltip, TooltipContent, TooltipTrigger} from "@/components/ui/tooltip";
import {useLatestRef} from "@/hooks/useLatestRef";
import {cn} from "@/lib/utils";

const CLIP_ID = "cb-squircle";
const RIM_ID = "cb-squircle-rim";

/** A superellipse (|x|^5 + |y|^5 = 1), the continuous corner of a native icon: a `rounded-*` arc reads visibly
 *  rounder. In objectBoundingBox units, so one path fits every size. */
const SQUIRCLE_D = `M${Array.from({length: 160}, (_, i) => {
    const t = (i / 160) * Math.PI * 2;
    const x = 0.5 + 0.5 * Math.sign(Math.cos(t)) * Math.abs(Math.cos(t)) ** 0.4;
    const y = 0.5 + 0.5 * Math.sign(Math.sin(t)) * Math.abs(Math.sin(t)) ** 0.4;
    return `${x.toFixed(5)},${y.toFixed(5)}`;
}).join("L")}Z`;

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

export function Squircle({
    size = 42,
    glass = true,
    className,
    children,
}: {
    size?: number | string;
    /** Off for a native icon asset: it carries its own depth, and the sheen on top reads as a smudge. */
    glass?: boolean;
    className?: string;
    children: ReactNode;
}) {
    return (
        <span
            className={cn("relative grid shrink-0 place-items-center", className)}
            style={{width: size, height: size, clipPath: `url(#${CLIP_ID})`}}
        >
            {children}
            {glass && (
                <>
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0"
                        style={{background: DOME}}
                    />
                    {/* A stroke on the clip path, not an inset box-shadow: a shadow follows border-radius and squares the corners. */}
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

/** One card for the whole home page: the tiles and the composer above them. */
export const HOME_SURFACE = "rounded-[18px] border border-border/60 bg-card";

/** The glyph every tile draws at: one number so art, avatars and channel glyphs agree. */
export const TILE_GLYPH = 36;

const TILE_CLASS =
    `group flex min-h-14 min-w-0 items-center gap-2.5 ${HOME_SURFACE} ` +
    "px-2.5 py-2 text-left transition-[transform,border-color] " +
    "duration-300 ease-[cubic-bezier(0.33,1,0.68,1)] hover:border-border " +
    "active:scale-[0.99] focus-visible:outline-2 " +
    "focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Keycap chrome: a real key in the command tile (`<kbd>`), a decorative hint elsewhere (`<span>`). */
export const KEYCAP_CLASS =
    "grid h-7 min-w-7 place-items-center rounded-[9px] border border-border " +
    "bg-linear-to-b from-card to-background px-1.5 font-sans text-[13.5px] font-medium " +
    "text-muted-foreground transition-colors group-hover:text-foreground";

/** Fires on an unmodified digit (⌘-digit already jumps to nav and pinned chats), never while anything else owns
 *  the keyboard. */
function useDigitShortcut(digit: number | undefined, run: () => void) {
    const latest = useLatestRef(run);
    useEffect(() => {
        if (digit === undefined) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
            if (e.key !== String(digit)) return;
            const el = e.target as HTMLElement | null;
            if (el?.isContentEditable) return;
            if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
            // Only a rendered dialog owns keys, not one kept mounted while hidden.
            const dialogs = document.querySelectorAll('[role="dialog"],[role="alertdialog"]');
            if ([...dialogs].some((d) => d.getBoundingClientRect().width > 0)) return;
            e.preventDefault();
            latest.current();
        };
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("keydown", onKey);
        };
    }, [digit, latest]);
}

export function HomeTile({
    glyph,
    label,
    value,
    to,
    onClick,
    trailing,
    shortcut,
    hotkey,
    className,
}: {
    glyph: ReactNode;
    label: string;
    value: string;
    to?: string;
    onClick?: () => void;
    trailing?: ReactNode;
    shortcut?: number;
    /** Key label for the hover hint when the tile has no digit shortcut. */
    hotkey?: string;
    className?: string;
}) {
    const navigate = useNavigate();
    const actionable = Boolean(to || onClick);
    const [side, setSide] = useState<"left" | "right">("right");
    const digit = actionable ? shortcut : undefined;
    useDigitShortcut(digit, () => {
        if (to) void navigate(to);
        else onClick?.();
    });

    const body = (
        <>
            <span className="relative shrink-0">{glyph}</span>
            <span className="flex min-w-0 flex-col gap-[3px]">
                <span className="truncate text-[12.5px] leading-[1.15] text-muted-foreground">
                    {label}
                </span>
                <span className="truncate text-[15px] leading-[1.2] tracking-[-0.01em] tabular-nums">
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

    const cls = cn(TILE_CLASS, !actionable && "cursor-default", className);
    const tile = to ? (
        <Link to={to} className={cls}>{body}</Link>
    ) : onClick ? (
        <button type="button" onClick={onClick} className={cls}>{body}</button>
    ) : (
        <div className={cls}>{body}</div>
    );
    const hint = digit !== undefined ? String(digit) : hotkey;
    if (!hint) return tile;

    return (
        <Tooltip>
            <TooltipTrigger
                delay={1200}
                render={tile}
                onPointerEnter={(e) => {
                    const grid = e.currentTarget.parentElement?.getBoundingClientRect();
                    setSide(grid && e.currentTarget.getBoundingClientRect().right < grid.right - 1 ? "left" : "right");
                }}
            />
            <TooltipContent side={side} sideOffset={12} collisionAvoidance={{side: "none"}} className="whitespace-nowrap">
                <span>
                    Tip: just press{" "}
                    <kbd className="inline-grid min-w-5 place-items-center rounded-md bg-background/20 px-1 font-sans font-medium">
                        {hint}
                    </kbd>
                </span>
            </TooltipContent>
        </Tooltip>
    );
}
