// In-VM sanitization for the live-activity lane (LIVE_AGENT_ACTIVITY_PLAN
// §3.4). This module is the single choke point between raw agent-event
// payloads (full tool args, full thinking text) and anything that leaves the
// machine: only the strings produced here are ever serialized into a status
// request. Policy: tool NAMES plus a sanitized summary of the PRIMARY arg;
// tool RESULTS never leave the VM at all.
//
// THE LENGTH CAPS ARE NOT THE SECURITY CONTROL and never were — redaction is.
// `isSafeSummaryValue` (SECRET_KEY_RE + the opaque-blob heuristic) and the
// wholesale fenced-code-block strip in `sanitizeThinkingTail` are what keep
// credentials and file contents in. The caps bound VOLUME: how much incidental
// argument text rides the ~1/s status lane. They were raised deliberately
// (owner decision, 2026-08-11) because at 80 chars a routine command was cut
// mid-flag — `find /home/node/.openclaw/workspace/skills/… -maxdepth 2 -type…`
// is 81 chars — so the UI could never show what the agent actually ran.
//
// Raising these increases the amount of agent tool-argument text leaving the
// sandbox. Redaction still runs on every value first. Keep them bounded: this
// lane is emitted roughly once per second per generating agent, so these
// numbers are also a bandwidth budget.
export const TOOL_SUMMARY_MAX_CHARS = 1000;
export const THINKING_TAIL_MAX_CHARS = 1000;

/** Keys whose values must never appear in a summary, wherever they occur. */
const SECRET_KEY_RE = /token|secret|password|passwd|authorization|cookie|bearer|credential|api[-_]?key|private[-_]?key/i;

/** Value-shape heuristic: long unbroken opaque blobs read as credentials
 *  (API keys, JWT segments, hashes) even under innocent keys — drop them. */
const SECRET_VALUE_RE = /^[A-Za-z0-9+/_=.-]{24,}$/;

/** Preferred arg fields per common tool shape, in priority order. The first
 *  present, non-secret string wins. Keeps summaries meaningful ("the command",
 *  "the query") instead of whatever key happens to sort first. */
const PRIMARY_ARG_KEYS = [
  "command",
  "query",
  "url",
  "path",
  "file_path",
  "filePath",
  "pattern",
  "prompt",
  "title",
  "name",
  "message",
  "text",
  "to",
  "action",
] as const;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  // Reserve one char for the ellipsis so the clamp is exact.
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function isSafeSummaryValue(key: string, value: string): boolean {
  if (SECRET_KEY_RE.test(key)) return false;
  const collapsed = collapseWhitespace(value);
  if (!collapsed) return false;
  if (!collapsed.includes(" ") && SECRET_VALUE_RE.test(collapsed)) return false;
  return true;
}

/** Pick the one arg string worth showing for a tool call, or undefined.
 *  Only ever looks at TOP-LEVEL string values — nested objects are not
 *  descended into (their stringification risks dragging payloads along). */
function pickPrimaryArg(args: unknown): string | undefined {
  if (typeof args === "string") {
    return isSafeSummaryValue("arg", args) ? args : undefined;
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  for (const key of PRIMARY_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && isSafeSummaryValue(key, value)) return value;
  }
  // Fallback: first top-level string value under a non-secret key, in the
  // object's own key order (deterministic per payload).
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && isSafeSummaryValue(key, value)) return value;
  }
  return undefined;
}

/** ``web_search: 'skale gas price'`` — or just the tool name when no arg
 *  survives sanitization. Never throws. */
export function sanitizeToolSummary(toolName: string, args: unknown): string {
  const name = collapseWhitespace(String(toolName || "tool")) || "tool";
  try {
    const primary = pickPrimaryArg(args);
    if (primary === undefined) return name;
    const snippet = truncate(collapseWhitespace(primary), TOOL_SUMMARY_MAX_CHARS);
    return snippet ? `${name}: '${snippet}'` : name;
  } catch {
    return name;
  }
}

/** Tail of the live thinking text, markdown-flattened and clamped. The tail
 *  (not the head) because the newest reasoning is the interesting part of a
 *  ticker-style display. */
export function sanitizeThinkingTail(text: unknown): string {
  if (typeof text !== "string") return "";
  const flattened = collapseWhitespace(
    text
      // Fenced code blocks can carry file contents — drop them wholesale.
      .replace(/```[\s\S]*?```/gu, " ")
      .replace(/`([^`]*)`/gu, "$1")
      .replace(/[*_#>]+/gu, " "),
  );
  if (flattened.length <= THINKING_TAIL_MAX_CHARS) return flattened;
  const tail = flattened.slice(-THINKING_TAIL_MAX_CHARS + 1);
  // Cut at the first word boundary inside the tail so we don't open mid-word.
  const firstSpace = tail.indexOf(" ");
  return `…${firstSpace > 0 && firstSpace < 24 ? tail.slice(firstSpace + 1) : tail}`;
}
