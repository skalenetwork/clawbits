import { SymbolView, type SFSymbol } from "expo-symbols";
import { useEffect, useState, type ReactNode } from "react";
import {
  DynamicColorIOS,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
  type ColorValue,
} from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { color } from "@/components/ui";
import {
  countOf,
  keepTurn,
  segmentOf,
  toggleTrace,
  useKeptTurn,
  useTraceOpen,
  useTurnHeadline,
  withThoughts,
  type KeptThought,
  type LiveTurn,
  type Segment,
} from "@/lib/liveTurn";
import type { Post, TurnStep } from "@/lib/models";
import { type Room, roomOf, stepLabel } from "@/lib/traceSteps";

const pair = (light: string, dark: string) => DynamicColorIOS({ light, dark });

/** The trace tiers of frontend/src/index.css over the system label, which is T1 itself. */
const tone = {
  quiet: pair("rgba(0,0,0,0.68)", "rgba(255,255,255,0.8)"),
  faint: pair("rgba(0,0,0,0.5)", "rgba(255,255,255,0.57)"),
  rail: pair("rgba(0,0,0,0.18)", "rgba(255,255,255,0.18)"),
  error: pair("#CD2121", "#F55452"),
  onError: pair("#F8F5EF", "#230D07"),
};

/** Hue is blast radius: one symbol per room from a closed set, every chip fill at one lightness so failure pops. */
const ROOMS: Record<Room, { symbol: SFSymbol; ink: ColorValue; chip: ColorValue }> = {
  find: { symbol: "magnifyingglass", ink: pair("#9D7720", "#E3B85D"), chip: pair("#EFDCB7", "#3E3011") },
  write: { symbol: "pencil", ink: pair("#4E8A4E", "#89CE88"), chip: pair("#CCE8CA", "#223922") },
  run: {
    symbol: "chevron.left.forwardslash.chevron.right",
    ink: pair("#078993", "#3ED0DD"),
    chip: pair("#BFE8EC", "#083A3E"),
  },
  read: { symbol: "doc.text", ink: pair("#657AC0", "#A7BDFF"), chip: pair("#D4DEF9", "#28314C") },
  reach: { symbol: "globe", ink: pair("#A668A1", "#EFA6E8"), chip: pair("#F0D5EC", "#41293E") },
  other: { symbol: "wrench.adjustable", ink: pair("#7F7C77", "#C0BDB8"), chip: pair("#E0DEDA", "#323232") },
};

/** The live effect breathes T1 text down to T2's alpha over the system background and back. */
const breathe = (low: number) =>
  ({
    animationName: { from: { opacity: low }, to: { opacity: 1 } },
    animationDuration: "800ms",
    animationDirection: "alternate",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  }) as const;
const breath = { light: breathe(0.68), dark: breathe(0.8) };
const turning = { transitionProperty: "transform", transitionDuration: 200 } as const;

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const crossfadeIn = FadeIn.duration(200);
const crossfadeOut = FadeOut.duration(200);

function duration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${String(m)}m ${String(Math.round(s % 60))}s` : `${String(Math.floor(m / 60))}h ${String(m % 60)}m`;
}

function labelOf(step: TurnStep) {
  return stepLabel(step.label.trim() || (step.tool ?? ""), roomOf(step.tool));
}

/** Runs of consecutive tool steps become one bracket; a note or a thinking burst sits outside it. */
function bracketed(rows: (TurnStep | KeptThought)[]): (TurnStep[] | TurnStep | KeptThought)[] {
  const out: (TurnStep[] | TurnStep | KeptThought)[] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if ("text" in row || row.kind === "note") out.push(row);
    else if (Array.isArray(last)) last.push(row);
    else out.push([row]);
  }
  return out;
}

function Chip({ step }: { step: TurnStep }) {
  const scheme = useColorScheme();
  const { symbol, ink, chip } = ROOMS[roomOf(step.tool)];
  const failed = step.ok === false;
  return (
    <View style={[trace.chip, { backgroundColor: failed ? tone.error : chip }]}>
      <SymbolView
        name={symbol}
        size={14}
        weight={scheme === "dark" ? "regular" : "medium"}
        tintColor={failed ? tone.onError : ink}
      />
    </View>
  );
}

function Spinner({ spinning }: { spinning: boolean }) {
  const still = useReducedMotion();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (still || !spinning) return;
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % SPINNER.length);
    }, 80);
    return () => {
      clearInterval(timer);
    };
  }, [still, spinning]);
  return (
    <Text accessibilityElementsHidden style={[trace.text, trace.faint]}>
      {SPINNER[frame]}
    </Text>
  );
}

/** Holds a line that was live here: when it leaves at settle with nothing to open, it fades while its height folds
 *  away, so the reply below it glides up rather than jumps. */
function Fold({ leaving, children }: { leaving: boolean; children: ReactNode }) {
  const height = useSharedValue(0);
  const shown = useSharedValue(1);
  useEffect(() => {
    if (leaving) shown.value = withTiming(0, { duration: 200 });
  }, [leaving, shown]);
  const style = useAnimatedStyle(() =>
    shown.value < 1 ? { height: height.value * shown.value, opacity: shown.value } : {},
  );
  return (
    <Animated.View
      onLayout={
        leaving
          ? undefined
          : (event) => {
              height.value = event.nativeEvent.layout.height;
            }
      }
      style={[trace.fold, leaving && trace.folding, style]}
    >
      {children}
    </Animated.View>
  );
}

/** The line's one live effect: its T1 text breathes down to T2's alpha and back, or rests at T1 under reduced
 *  motion. */
function useBreath(on: boolean) {
  const dark = useColorScheme() === "dark";
  const still = useReducedMotion();
  return on && !still ? breath[dark ? "dark" : "light"] : null;
}

function SegmentView({ segment, after }: { segment: Segment; after: boolean }) {
  const breathing = useBreath(segment.live);
  const ink = segment.live ? null : trace.quiet;
  if (segment.kind === "text")
    return (
      <>
        {after && <Text style={[trace.text, trace.faint]}> · </Text>}
        <Animated.Text numberOfLines={1} style={[trace.text, trace.shrink, ink, breathing]}>
          {segment.text}
        </Animated.Text>
      </>
    );
  const { head, tail } = labelOf(segment.step);
  return (
    <>
      <Chip step={segment.step} />
      <Animated.View style={[trace.shrinkRow, breathing]}>
        <Text numberOfLines={1} style={[trace.text, trace.shrink, ink]}>
          <Text style={trace.strong}>{head}</Text>
          {tail && ` ${tail}`}
        </Text>
        {segment.more > 0 && <Text style={[trace.text, ink]}> and {segment.more} more</Text>}
      </Animated.View>
    </>
  );
}

function ToolRow({ step }: { step: TurnStep }) {
  const { head, tail } = labelOf(step);
  const failed = step.ok === false;
  const ms = step.duration_ms;
  return (
    <View style={trace.row}>
      <Chip step={step} />
      <Text style={[trace.text, trace.label]}>
        <Text style={trace.strong}>{head}</Text>
        {tail && <Text style={trace.quiet}> {tail}</Text>}
      </Text>
      {failed && <Text style={[trace.text, trace.failed]}>failed</Text>}
      <Text style={[trace.text, trace.duration]}>
        {ms != null && (failed || ms >= 500) ? duration(ms) : null}
      </Text>
    </View>
  );
}

/**
 * The one line that owns an agent's turn, above its reply: the same row from the first heartbeat through the settle.
 * Its slot spins for as long as the turn is live, so a held step never reads as stalled; the chevron takes over when
 * the line opens and once the turn settles. The count ("N steps", or "Thought"
 * for a turn that only thought or narrated, once the segment stops saying so) and "K failed" never move; the segment
 * after them says what the agent is doing, empties while the reply streams, and crossfades into "spanned" at settle.
 * A settled turn with nothing to open leaves, folding away when it was live here. Open, the rows sit under the line
 * in the order they happened, thinking included while this session holds it. The bracket asserts order, not
 * causality: these steps ran after the row above and before the next.
 */
export function TurnTrace({ post, turn }: { post?: Post; turn?: LiveTurn }) {
  const settled = post?.status === "published";
  const [lived] = useState(!settled);
  const still = useReducedMotion();
  const headline = useTurnHeadline(settled ? undefined : turn);
  const traceKey = settled ? String(post.post_id) : turn?.key;
  const open = useTraceOpen(traceKey);
  const kept = useKeptTurn(settled ? post : undefined);
  const steps = (settled ? (post.steps?.length ? post.steps : kept?.steps) : turn?.steps) ?? [];
  const thoughts = (settled ? kept?.thoughts : turn && keepTurn(turn).thoughts) ?? [];
  const writing = !settled && !!post?.message;
  const openable = !!traceKey && steps.length + thoughts.length > 0;
  const leaving = settled && !openable;
  const spanned = settled && post.published_at ? Date.parse(post.published_at) - Date.parse(post.created_at) : 0;
  const segment: Segment | undefined = settled
    ? openable && spanned >= 10_000
      ? { kind: "text", key: "spanned", text: `spanned ${duration(spanned)}`, live: false }
      : undefined
    : segmentOf(steps, headline, writing);
  const counting = useBreath(!settled && !segment?.live);
  if (leaving && (!lived || still)) return null;
  const count = countOf(steps, thoughts, !settled && !!segment);
  const failures = steps.filter((s) => s.kind === "tool" && s.ok === false).length;
  const line = (
    <View style={trace.box}>
      <Pressable
        accessibilityRole={openable ? "button" : undefined}
        accessibilityState={openable ? { expanded: open } : undefined}
        hitSlop={8}
        style={trace.line}
        onPress={
          openable
            ? () => {
                toggleTrace(traceKey);
              }
            : undefined
        }
      >
        <View style={trace.slot}>
          {openable && (settled || open) ? (
            <Animated.View style={{ ...turning, transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
              <SymbolView name="chevron.right" size={9} weight="semibold" tintColor={tone.faint} />
            </Animated.View>
          ) : (
            <Spinner spinning={!settled} />
          )}
        </View>
        <LayoutAnimationConfig skipEntering skipExiting>
          <View style={trace.lineText}>
            {!!count && <Animated.Text style={[trace.text, trace.strong, counting]}>{count}</Animated.Text>}
            {failures > 0 && (
              <Text style={trace.text}>
                <Text style={trace.faint}> · </Text>
                <Text style={trace.failed}>{failures} failed</Text>
              </Text>
            )}
            {segment && (
              <Animated.View
                key={segment.key}
                entering={crossfadeIn}
                exiting={crossfadeOut}
                style={[trace.shrinkRow, trace.segment, segment.kind === "tool" && trace.tool]}
              >
                <SegmentView segment={segment} after={!!count} />
              </Animated.View>
            )}
          </View>
        </LayoutAnimationConfig>
      </Pressable>
      {open && (
        <View style={trace.body}>
          {bracketed(withThoughts(steps, thoughts)).map((row, i) =>
            Array.isArray(row) ? (
              <View key={row[0].id} style={trace.bracket}>
                <View style={[trace.rail, row.some((s) => s.ok === false) && trace.railFailed]} />
                {row.map((s) => (
                  <ToolRow key={s.id} step={s} />
                ))}
              </View>
            ) : "text" in row ? (
              <Text key={`thought:${row.before ?? ""}`} style={[trace.text, trace.note, i > 0 && trace.beat]}>
                <Text style={trace.faint}>Thinking · </Text>
                {row.text}
              </Text>
            ) : (
              <Text key={row.id} style={[trace.text, trace.note, i > 0 && trace.beat]}>
                {row.label}
              </Text>
            ),
          )}
        </View>
      )}
    </View>
  );
  return lived ? <Fold leaving={leaving}>{line}</Fold> : line;
}

const trace = StyleSheet.create({
  box: { alignSelf: "stretch", marginLeft: 16, marginBottom: 8 },
  fold: { alignSelf: "stretch" },
  folding: { overflow: "hidden" },
  line: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24, paddingVertical: 2 },
  lineText: { flex: 1, flexDirection: "row", alignItems: "center" },
  shrinkRow: { flexDirection: "row", flexShrink: 1 },
  segment: { alignItems: "center" },
  tool: { marginLeft: 8, gap: 8 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8, minHeight: 24, paddingVertical: 2 },
  slot: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  chip: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  text: { fontSize: 13, lineHeight: 20, color: color.text },
  label: { flex: 1 },
  shrink: { flexShrink: 1 },
  strong: { fontWeight: "500" },
  quiet: { color: tone.quiet },
  faint: { color: tone.faint },
  failed: { fontWeight: "500", color: tone.error },
  duration: { width: 48, textAlign: "right", color: tone.faint, fontVariant: ["tabular-nums"] },
  body: { paddingTop: 8, paddingBottom: 4 },
  note: { paddingVertical: 2, color: tone.quiet },
  beat: { marginTop: 12 },
  bracket: { paddingLeft: 16 },
  rail: { position: "absolute", top: 6, bottom: 6, left: 7, width: 1, borderRadius: 1, backgroundColor: tone.rail },
  railFailed: { left: 6.5, width: 2, backgroundColor: tone.error },
});
