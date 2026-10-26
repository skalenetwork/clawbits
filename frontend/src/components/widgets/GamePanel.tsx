import { lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Ban, ChevronDown, ChevronUp, PanelRightClose, X } from "lucide-react";
import { SIDEBAR_SCROLL } from "@/components/ProgressiveBlur";
import { PANEL_ICON_BUTTON, RightPanelSlotContext } from "@/components/sidebars/rightPanelContext";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWidget, useWidgetAction } from "@/hooks/useWidget";
import type { Widget } from "@/lib/api";
import { cn } from "@/lib/utils";
import { scoreLabel, scoreOf, scoreTitle, seatOf, statusOf, waitsOn, type SeatScore } from "@/lib/widgets";
import { setWidgetView, useWidgetView } from "@/lib/widgetView";
import { KindGlyph } from "./KindGlyph";
import { WidgetSkeleton } from "./WidgetCard";
import "./widgets.css";

const WidgetPanel = lazy(() => import("./WidgetPanel"));

/** How long a game seen ending keeps its result open before it folds to its strip. */
const RESULT_HOLD_MS = 6_000;
/** Below this a window has no room for the chat beside an open column, so a running game waits as its strip. */
const ROOMY_PX = 1180;
/** From this width the game column sits beside Info, Attachments or Pinned rather than under them. */
const BESIDE_PANELS_PX = 1600;

// A round icon control on the glass bar.
const BAR_BUTTON =
  "grid size-9 shrink-0 place-items-center rounded-full text-(--w-on-surface-variant) outline-none hover:bg-(--w-state-hover) focus-visible:shadow-[0_0_0_2px_var(--w-primary)] disabled:opacity-50";

interface GameProps {
  widgetId: string;
  channelId: string;
  userId: number | null;
  /** Picked from its line in the chat: an ended game stays open for its player to look at. */
  picked: boolean;
  /** The game was dismissed, so the chat can show its running one instead. */
  onDismiss: () => void;
}

/** Whether the window is at least `px` wide, as it changes; `otherwise` where it can't be asked. */
function useMinWidth(px: number, otherwise: boolean): boolean {
  const query = `(min-width: ${String(px)}px)`;
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window.matchMedia !== "function") return () => undefined;
    const mql = window.matchMedia(query);
    mql.addEventListener("change", onChange);
    return () => { mql.removeEventListener("change", onChange); };
  }, [query]);
  return useSyncExternalStore(subscribe, () =>
    typeof window.matchMedia === "function" ? window.matchMedia(query).matches : otherwise);
}

/** What the panel shows of a game, from the view this device chose. A running game opens on a wide screen and waits
 *  in its bar on a narrow one until the player says otherwise; a collapsed one never opens by itself. One seen ending
 *  while open, or found ended where its player left it open, keeps its result open a moment (counted only while in
 *  sight), then folds to its strip, where it waits to be dismissed. */
function useGameView(
  widget: Widget,
  { narrow, paused, picked }: { narrow: boolean; paused: boolean; picked: boolean },
  onDismiss: () => void,
) {
  const widgetId = widget.widget_id;
  const view = useWidgetView(widgetId);
  const active = widget.status === "active";
  const openWhileActive = view === "open" || (view == null && !narrow);
  const [wasActive, setWasActive] = useState(active);
  // Ended out of sight where it was left open: its result shows once too, unless its player just picked it to look at.
  const [holding, setHolding] = useState(() => !active && view === "open" && !picked);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active && openWhileActive) setHolding(true);
  }
  useEffect(() => {
    if (!holding || paused) return;
    const timer = window.setTimeout(() => {
      setHolding(false);
      setWidgetView(widgetId, "collapsed");
    }, RESULT_HOLD_MS);
    return () => { window.clearTimeout(timer); };
  }, [holding, paused, widgetId]);
  const shown = view === "dismissed" ? "none" : holding || (active ? openWhileActive : view === "open") ? "open" : "strip";
  return {
    shown,
    open: () => { setWidgetView(widgetId, "open"); },
    collapse: () => {
      setHolding(false);
      setWidgetView(widgetId, "collapsed");
    },
    dismiss: () => {
      setHolding(false);
      setWidgetView(widgetId, "dismissed");
      onDismiss();
    },
  };
}

/** The game in a few words for its strip and its bar, and their name for a screen reader, which says the turn and
 *  the chat's score too. */
function summaryOf(widget: Widget, userId: number | null) {
  const seat = seatOf(widget, userId);
  const title = widget.scene.title ?? widget.kind;
  const status = statusOf(widget, seat);
  const myMove = waitsOn(widget, seat);
  const score = scoreOf(widget, userId);
  const label = [title, status, myMove && "your move", score && scoreLabel(score)].filter(Boolean).join(", ");
  return { seat, title, status, myMove, score, label };
}

/** The chat's score beside the game, the viewer's wins first; the draws are in its tooltip and its words. */
function ScoreChip({ score }: { score: SeatScore }) {
  return (
    <span
      data-score=""
      title={scoreTitle(score)}
      className="shrink-0 rounded-full bg-foreground/6 px-1.5 py-0.5 text-[11px] leading-none font-normal tabular-nums text-muted-foreground"
    >
      <span aria-hidden>{`${String(score.mine)}–${String(score.theirs)}`}</span>
      <span className="sr-only">{`, ${scoreLabel(score)}`}</span>
    </span>
  );
}

/** End game, for a player while it runs: it ends for both, with no winner, once confirmed. */
function EndGame({ widget, className }: { widget: Widget; className: string }) {
  const act = useWidgetAction();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="End game"
        title="End game"
        disabled={act.isPending}
        onClick={() => { setConfirming(true); }}
        className={className}
      >
        <Ban aria-hidden className="size-4" />
      </button>
      <Dialog open={confirming} onOpenChange={(next) => { setConfirming(next); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>End this game?</DialogTitle>
            <DialogDescription>It ends for both players, with no winner.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => { setConfirming(false); }}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                act.mutate({ widget, action: { type: "end", args: {} } });
              }}
            >
              End game
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The chat's game at the right edge of a wide screen, in the right panels' frame: open beside the chat, or collapsed
 *  to a strip with the game's glyph, its state and a dot when it's your move. Info, Attachments and Pinned cover it
 *  while they're open, but on a very wide screen it sits beside them. */
export function GameColumn({ covered, ...props }: GameProps & { covered: boolean }) {
  const slot = useContext(RightPanelSlotContext);
  const { data: widget } = useWidget(props.widgetId);
  // A widget shows only in the chat it lives in.
  if (!slot || !widget || widget.channel_id !== props.channelId) return null;
  return createPortal(
    <Column widget={widget} userId={props.userId} picked={props.picked} covered={covered} onDismiss={props.onDismiss} />,
    slot,
  );
}

function Column({ widget, userId, picked, covered, onDismiss }: {
  widget: Widget;
  userId: number | null;
  picked: boolean;
  covered: boolean;
  onDismiss: () => void;
}) {
  const roomy = useMinWidth(ROOMY_PX, true);
  const besidePanels = useMinWidth(BESIDE_PANELS_PX, false);
  const hidden = covered && !besidePanels;
  const game = useGameView(widget, { narrow: !roomy, paused: hidden, picked }, onDismiss);
  const { seat, title, status, myMove, score, label } = summaryOf(widget, userId);
  const active = widget.status === "active";
  const shown = hidden ? "none" : game.shown;
  // A click that swaps the open column for its strip, or back, hands focus to the control that takes its place.
  const refocus = useRef(false);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const stripRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    (game.shown === "open" ? collapseRef : stripRef).current?.focus();
  }, [game.shown]);
  // Boards side by side (a fleet each) take a wider column.
  const wide = (widget.scene.boards?.length ?? 1) > 1;
  return (
    <aside
      aria-label="Game"
      data-state={shown}
      aria-hidden={shown === "none"}
      inert={shown === "none"}
      className={cn(
        "relative z-[45] hidden shrink-0 overflow-hidden bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-linear md:flex",
        shown === "none" ? "w-0" : shown === "strip" ? "w-12" : wide ? "w-[26rem]" : "w-[22rem]",
      )}
    >
      {game.shown === "open" ? (
        <div className={cn("flex shrink-0 flex-col", wide ? "w-[26rem]" : "w-[22rem]")}>
          <div className="px-2">
            <div data-tauri-drag-region className="flex h-(--header-height) items-center gap-1 pl-2.5">
              <h2 className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-medium">
                <KindGlyph kind={widget.kind} aria-hidden className="size-4 shrink-0" />
                <span className="truncate">{title}</span>
                {score && <ScoreChip score={score} />}
              </h2>
              {active && seat && <EndGame widget={widget} className={PANEL_ICON_BUTTON} />}
              {!active && (
                <button type="button" aria-label="Dismiss game" title="Dismiss game" onClick={game.dismiss} className={PANEL_ICON_BUTTON}>
                  <X className="size-4" />
                </button>
              )}
              <button
                ref={collapseRef}
                type="button"
                aria-expanded
                aria-label="Collapse game"
                title="Collapse game"
                onClick={() => {
                  refocus.current = true;
                  game.collapse();
                }}
                className={PANEL_ICON_BUTTON}
              >
                <PanelRightClose className="size-4" />
              </button>
            </div>
          </div>
          <div className={SIDEBAR_SCROLL}>
            <Suspense fallback={<WidgetSkeleton />}>
              <WidgetPanel widget={widget} userId={userId} />
            </Suspense>
          </div>
        </div>
      ) : (
        <div className="flex w-12 shrink-0 flex-col items-center gap-1 pb-2">
          <button
            ref={stripRef}
            type="button"
            aria-expanded={false}
            aria-label={label}
            title="Show game"
            onClick={() => {
              refocus.current = true;
              game.open();
            }}
            className="wgt flex min-h-0 w-full flex-1 flex-col items-center gap-2 outline-none hover:bg-[var(--sb-hover)] focus-visible:shadow-[inset_0_0_0_2px_var(--w-primary)]"
          >
            <span className="relative grid h-(--header-height) shrink-0 place-items-center">
              <KindGlyph kind={widget.kind} aria-hidden className="size-5 text-(--w-on-primary-container)" />
              {/* The turn, said by the label too, not only by this dot. */}
              {myMove && (
                <span aria-hidden className="absolute top-[calc(50%-0.875rem)] -right-1.5 size-2.5 rounded-full bg-(--w-primary) ring-2 ring-sidebar" />
              )}
            </span>
            {score && <ScoreChip score={score} />}
            <span className="min-h-0 truncate text-[13px] text-(--w-on-surface-variant) [writing-mode:vertical-rl]">{status}</span>
          </button>
          {!active && (
            <button type="button" aria-label="Dismiss game" title="Dismiss game" onClick={game.dismiss} className={PANEL_ICON_BUTTON}>
              <X className="size-4" />
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

/** The chat's game on a narrow screen: a slim glass bar pinned at the top of the chat, with the game's glyph, its
 *  state and a dot when it's your move, that opens into the board beneath it. It floats over the chat, so it is
 *  glass; the chat keeps its first message clear of it. */
export function GameBar(props: GameProps) {
  const { data: widget } = useWidget(props.widgetId);
  // A widget shows only in the chat it lives in.
  if (!widget || widget.channel_id !== props.channelId) return null;
  return <Bar widget={widget} userId={props.userId} picked={props.picked} onDismiss={props.onDismiss} />;
}

function Bar({ widget, userId, picked, onDismiss }: {
  widget: Widget;
  userId: number | null;
  picked: boolean;
  onDismiss: () => void;
}) {
  const game = useGameView(widget, { narrow: true, paused: false, picked }, onDismiss);
  const { seat, status, myMove, score, label } = summaryOf(widget, userId);
  const active = widget.status === "active";
  if (game.shown === "none") return null;
  const open = game.shown === "open";
  return (
    <div
      data-game-bar=""
      className="wgt pointer-events-none absolute inset-x-0 top-[calc(var(--safe-top,0px)+4rem)] z-20 flex flex-col gap-2 px-3"
    >
      <div className="wgt-glass pointer-events-auto mx-auto flex h-11 w-full max-w-chat items-center gap-0.5 rounded-full pr-1">
        <button
          type="button"
          aria-expanded={open}
          aria-label={label}
          onClick={open ? game.collapse : game.open}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-full pr-1 pl-3.5 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--w-primary)]"
        >
          <span className="relative grid shrink-0 place-items-center">
            <KindGlyph kind={widget.kind} aria-hidden className="size-[1.125rem] text-(--w-on-primary-container)" />
            {/* The turn, said by the label too, not only by this dot. */}
            {myMove && (
              <span aria-hidden className="absolute -top-1 -right-1.5 size-2.5 rounded-full bg-(--w-primary) ring-2 ring-(--w-surface)" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-left text-[0.875rem] font-medium">{status}</span>
          {score && <ScoreChip score={score} />}
          {open ? (
            <ChevronUp aria-hidden className="size-4 shrink-0 text-(--w-on-surface-variant)" />
          ) : (
            <ChevronDown aria-hidden className="size-4 shrink-0 text-(--w-on-surface-variant)" />
          )}
        </button>
        {open && active && seat && <EndGame widget={widget} className={BAR_BUTTON} />}
        {!active && (
          <button type="button" aria-label="Dismiss game" title="Dismiss game" onClick={game.dismiss} className={BAR_BUTTON}>
            <X aria-hidden className="size-4" />
          </button>
        )}
      </div>
      {open && (
        // Down to the composer, no further: a tall board scrolls inside.
        <div className="pointer-events-auto mx-auto max-h-[calc(var(--vvh,100svh)-var(--safe-top,0px)-var(--composer-height,112px)-7.75rem)] w-full max-w-chat overflow-y-auto overscroll-contain rounded-[1.5rem]">
          <Suspense fallback={<WidgetSkeleton />}>
            <WidgetPanel widget={widget} userId={userId} variant="sheet" className="max-w-none" />
          </Suspense>
        </div>
      )}
    </div>
  );
}
