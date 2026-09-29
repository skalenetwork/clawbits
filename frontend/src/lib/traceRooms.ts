import {
  Database01Icon,
  File01Icon,
  FileEditIcon,
  Globe02Icon,
  Image01Icon,
  Mail01Icon,
  Search01Icon,
  SourceCodeIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

/**
 * A tool's ROOM — what the step could affect, not which tool ran it.
 *
 * The label already says which tool ran (`python3 …`, `markets.json`), so
 * colouring by tool family spends the only colour channel we have on
 * information the text already carries. Blast radius is the one question the
 * text CANNOT answer: `python3 prep.py`, `ls -1 /tmp/…` and `cat SKILL.md` all
 * read as commands and filenames, but one of them executes, one of them looks,
 * and one of them reads. Ordered here by consequence.
 */
export type Room = "find" | "read" | "write" | "run" | "reach" | "other";

export interface RoomPresentation {
  room: Room;
  icon: IconSvgElement;
  /** Screen-reader text; the chip is decorative to sighted users. */
  label: string;
}

const ROOM_LABEL: Record<Room, string> = {
  find: "searched",
  read: "read",
  write: "edited",
  run: "ran",
  reach: "reached out",
  other: "tool",
};

// Ordered most-specific first; the first match on the normalised tool name
// wins. Names are normalised by turning `_ - .` into spaces so `\b` works on
// tool tokens (`read_file` → `read file`), which keeps short keywords (`cat`,
// `ls`, `sh`) from matching mid-word — `concatenate` must not read as `cat`.
//
// NOTE the ordering constraint that used to be a bug: `web search` must be
// tested BEFORE the generic search rule. In the old toolPresentation table
// Search01Icon served both web-search and grep/glob/find/ls. Under this
// taxonomy those are different rooms — `reach` (left the box) vs `find` (looked
// locally) — so sharing a glyph made them differ by HUE ALONE, and under
// tritanopia the two hues collapse. Web search now takes Globe02Icon, which
// already means "outside the box", and Search01Icon is exclusively `find`.
const RULES: { test: RegExp; room: Room; icon: IconSvgElement }[] = [
  { test: /\bweb ?search\b|\bgoogle\b|\bbrave\b|\bduckduckgo\b|\bserp\b/, room: "reach", icon: Globe02Icon },
  { test: /\bbrowse\b|\bbrowser\b|\bnavigate\b|open url|\bvisit\b|puppeteer|playwright/, room: "reach", icon: Globe02Icon },
  { test: /\bhttp\b|\bfetch\b|\brequest\b|\bcurl\b|web fetch|\burl\b|\bscrape\b/, room: "reach", icon: Globe02Icon },
  { test: /\bemail\b|\bmail\b|\bsmtp\b|gmail|send message/, room: "reach", icon: Mail01Icon },
  { test: /generate image|image gen|\bdall|render image|\bdraw\b|diffusion/, room: "reach", icon: Image01Icon },
  { test: /\bsql\b|database|postgres|query db|sqlite|mongo/, room: "read", icon: Database01Icon },
  { test: /\bgrep\b|\bglob\b|\bfind\b|list dir|\bls\b|search file/, room: "find", icon: Search01Icon },
  { test: /\bwrite\b|create file|\bsave\b|str replace|\bedit\b|editor|\bpatch\b|\bapply\b/, room: "write", icon: FileEditIcon },
  { test: /\bread\b|\bcat\b|\bview\b|get file|open file/, room: "read", icon: File01Icon },
  { test: /\bbash\b|\bshell\b|\bexec\b|\bterminal\b|\bcommand\b|run command|\bzsh\b|\bsh\b/, room: "run", icon: SourceCodeIcon },
  { test: /\bpython\b|\bnode\b|\bcode\b|\bexecute\b|\brepl\b|jupyter|interpreter|\bcompile\b/, room: "run", icon: SourceCodeIcon },
];

/** Everything with no rule. Never blank, never the raw tool string as a glyph. */
const FALLBACK: RoomPresentation = { room: "other", icon: Wrench01Icon, label: ROOM_LABEL.other };

/**
 * Resolve a tool name to its room + glyph. Reads the TOOL NAME ONLY — never the
 * command text. A resolver that reads the label grows a new glyph per binary,
 * forever, and `label` is agent-authored free text.
 */
export function roomOf(tool: string | null | undefined): RoomPresentation {
  if (!tool) return FALLBACK;
  const norm = tool.toLowerCase().replace(/[_\-.]+/g, " ");
  for (const rule of RULES) {
    if (rule.test.test(norm)) {
      return { room: rule.room, icon: rule.icon, label: ROOM_LABEL[rule.room] };
    }
  }
  return FALLBACK;
}

/** A step's label as displayed: the token that identifies the step (T1, weight 500), then what qualifies it (T2). */
export interface StepLabel {
  head: string;
  tail: string;
}

/** The plugin's `name: …` prefix, which the chip already says. */
const NAMED = /^[\w.-]+: (.*)$/;
/** `'value'` or `action 'value'`; an older plugin's length cut can drop the closing quote. */
const QUOTED = /^(?:([a-z][\w-]{0,31}) )?'(.*?)'?$/i;
/** A path's directory and its basename, a trailing slash kept on the basename. */
const PATH = /^(.*)\/([^/]+\/?)$/;
/** The agent's home, or the OpenClaw workspace inside it, up to a `/`. */
const HOME = /^\/home\/[^/]+(?:\/\.openclaw\/workspace)?(?=\/|$)/;

/**
 * Split a step's sanitized label into head and tail.
 *
 * Unwraps the plugin's forms first: `name: 'value'`, `name: action 'value'`, `name: detail` and a bare `name`. A
 * path inverts wherever it appears, keyed on the value's shape and never the room: basename first, then its directory
 * with the home or workspace prefix elided at a `/`. A command (the run room) splits at token zero: token zero plus
 * up to two following bare words. Hunting for the "subject" mid-command is a heuristic over an unbounded space (pipes
 * make `head` the subject, `git commit -m "…"` has no clean operand), and a wrong dark word inverts the hierarchy
 * silently. Anything else is all head. An action qualifier trails the tail.
 */
export function stepLabel(label: string, room: Room): StepLabel {
  const named = NAMED.exec(label);
  const quoted = named && QUOTED.exec(named[1] ?? "");
  const value = (quoted ? quoted[2] : (named?.[1] ?? label)) || (label.split(":")[0] ?? "");
  const action = quoted?.[1]?.replace(/_|(?<=[a-z])(?=[A-Z])/g, " ").toLowerCase();
  const { head, tail } = splitValue(value, room);
  return { head, tail: action ? [tail, action].filter(Boolean).join(" ") : tail };
}

function splitValue(value: string, room: Room): StepLabel {
  const path = /\s|:\/\//.test(value) ? null : PATH.exec(value);
  if (path) return { head: path[2] ?? "", tail: (path[1] ?? "").replace(HOME, "…") || "/" };
  if (room !== "run") return { head: value, tail: "" };
  const toks = value.split(/\s+/);
  let n = 1;
  while (n < 3 && /^[a-z][a-z0-9-]*$/.test(toks[n] ?? "")) n += 1;
  return { head: toks.slice(0, n).join(" "), tail: toks.slice(n).join(" ") };
}
