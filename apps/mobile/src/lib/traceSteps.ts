/**
 * A finished turn's tool steps as the trace shows them: each tool's room and each label's head and tail.
 * Kept in step with frontend/src/lib/traceRooms.ts.
 */

/** What a step could affect, not which tool ran it, ordered by consequence. */
export type Room = "find" | "read" | "write" | "run" | "reach" | "other";

/** Most specific first; `web search` must precede the generic search rule, or reach and find share a glyph. */
const RULES: [RegExp, Room][] = [
  [/\bweb ?search\b|\bgoogle\b|\bbrave\b|\bduckduckgo\b|\bserp\b/, "reach"],
  [/\bbrowse\b|\bbrowser\b|\bnavigate\b|open url|\bvisit\b|puppeteer|playwright/, "reach"],
  [/\bhttp\b|\bfetch\b|\brequest\b|\bcurl\b|web fetch|\burl\b|\bscrape\b/, "reach"],
  [/\bemail\b|\bmail\b|\bsmtp\b|gmail|send message/, "reach"],
  [/generate image|image gen|\bdall|render image|\bdraw\b|diffusion/, "reach"],
  [/\bsql\b|database|postgres|query db|sqlite|mongo/, "read"],
  [/\bgrep\b|\bglob\b|\bfind\b|list dir|\bls\b|search file/, "find"],
  [/\bwrite\b|create file|\bsave\b|str replace|\bedit\b|editor|\bpatch\b|\bapply\b/, "write"],
  [/\bread\b|\bcat\b|\bview\b|get file|open file/, "read"],
  [/\bbash\b|\bshell\b|\bexec\b|\bterminal\b|\bcommand\b|run command|\bzsh\b|\bsh\b/, "run"],
  [/\bpython\b|\bnode\b|\bcode\b|\bexecute\b|\brepl\b|jupyter|interpreter|\bcompile\b/, "run"],
];

/** Resolve a tool name to its room. Reads the tool name only, never the agent-authored label. */
export function roomOf(tool: string | null): Room {
  if (!tool) return "other";
  const norm = tool.toLowerCase().replace(/[_\-.]+/g, " ");
  return RULES.find(([test]) => test.test(norm))?.[1] ?? "other";
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
 * Unwraps `name: 'value'`, `name: action 'value'`, `name: detail` and a bare `name`. A path inverts wherever it
 * appears, keyed on its shape and never the room: basename first, then its directory with the home or workspace
 * prefix elided at a `/`. A command (the run room) splits at token zero plus up to two following bare words.
 * Anything else is all head. An action qualifier trails the tail.
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
