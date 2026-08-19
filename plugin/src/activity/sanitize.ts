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

/** Junk-drawer variants of a discriminated union — they name no operation.
 *  OpenClaw's Codex projector emits ``{action: "other", queryUnavailable: true}``
 *  for a `web_search` call whose action the Codex app-server could not classify,
 *  and `other` was then the only string in the payload, so the lane rendered
 *  `web_search: 'other'` — indistinguishable from a search FOR the word. */
const OPAQUE_ACTIONS = new Set(["other", "unknown", "unspecified", "none"]);

function isOpaqueAction(key: string, value: string): boolean {
  return key === "action" && OPAQUE_ACTIONS.has(collapseWhitespace(value).toLowerCase());
}

/** Safe to show AND worth showing. */
function isSummaryCandidate(key: string, value: string): boolean {
  return isSafeSummaryValue(key, value) && !isOpaqueAction(key, value);
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
  // The producer says outright that the interesting argument is missing, so
  // whatever else is in the payload is bookkeeping, not content.
  if (record.queryUnavailable === true) return undefined;
  for (const key of PRIMARY_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && isSummaryCandidate(key, value)) return value;
  }
  // Fallback: first top-level string value under a non-secret key, in the
  // object's own key order (deterministic per payload).
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && isSummaryCandidate(key, value)) return value;
  }
  return undefined;
}

/** The discriminator naming WHICH operation a multi-purpose tool ran, when the
 *  primary arg is something else. `web_search: 'https://example.com'` cannot say
 *  whether the agent searched for that URL or opened it; `web_search: open_page
 *  'https://example.com'` can. Bounded to a single enum-shaped token so it can
 *  never smuggle prose past the length budget. */
function pickActionQualifier(args: unknown, primary: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const action = (args as Record<string, unknown>).action;
  if (typeof action !== "string") return undefined;
  const token = collapseWhitespace(action);
  if (token === primary || isOpaqueAction("action", token)) return undefined;
  return /^[a-z][a-z0-9_-]{0,31}$/i.test(token) ? token : undefined;
}

/** ``web_search: 'skale gas price'``, ``web_search: open_page 'https://…'`` —
 *  or just the tool name when no arg survives sanitization. Never throws. */
export function sanitizeToolSummary(toolName: string, args: unknown): string {
  const name = collapseWhitespace(String(toolName || "tool")) || "tool";
  try {
    const primary = pickPrimaryArg(args);
    if (primary === undefined) return name;
    const snippet = truncate(collapseWhitespace(primary), TOOL_SUMMARY_MAX_CHARS);
    if (!snippet) return name;
    const action = pickActionQualifier(args, snippet);
    return action ? `${name}: ${action} '${snippet}'` : `${name}: '${snippet}'`;
  } catch {
    return name;
  }
}

/** OpenClaw's own formatted detail for a tool call (the ``meta`` field on a
 *  ``tool`` agent event), as a label.
 *
 *  It exists for one reason: the Codex harness emits the tool START from the
 *  app-server's `item/started`, and at that point a `webSearch` item carries no
 *  query — only `{action: "other"}` — so the start label CANNOT say what is
 *  being searched. The query arrives with `item/completed`, and OpenClaw
 *  formats it into `meta` on the result event. This is therefore the first (and
 *  only) moment the lane can report the actual search.
 *
 *  Same redaction and cap as an argument summary. A lone double-quoted run is
 *  re-quoted so the result matches the ``name: 'value'`` form used elsewhere. */
export function sanitizeToolDetail(toolName: string, meta: unknown): string | undefined {
  if (typeof meta !== "string") return undefined;
  try {
    const name = collapseWhitespace(String(toolName || "tool")) || "tool";
    const collapsed = collapseWhitespace(meta);
    if (!collapsed || !isSafeSummaryValue("meta", collapsed)) return undefined;
    const quoted = /^"([^"]*)"$/u.exec(collapsed);
    const detail = truncate(quoted?.[1] ?? collapsed, TOOL_SUMMARY_MAX_CHARS);
    if (!detail || detail === name) return undefined;
    return quoted ? `${name}: '${detail}'` : `${name}: ${detail}`;
  } catch {
    return undefined;
  }
}

/** The only keys ever read out of a tool RESULT payload.
 *
 *  The lane's standing rule is that tool results stay in the VM, and these keys
 *  are the deliberate, minimal exception — they are CALL DESCRIPTORS that the
 *  harness echoes back, not output. For a Codex `web_search` the result object
 *  is `{status, durationMs, query?, queries?, action?, url?, pattern?}`, built
 *  by the same projector function that builds the start args: no hits, no
 *  snippets, no titles, no page text anywhere in it. Reading exactly these is
 *  what lets the lane say WHICH page the agent opened — an `openPage` call
 *  reports its URL only on completion, and OpenClaw's `meta` formatter covers
 *  queries but not URLs, so this is the only report of it.
 *
 *  Everything else in a result is ignored. Do not extend this list with keys
 *  that can carry a tool's OUTPUT (`content`, `text`, `output`, `results`,
 *  `body`, …) — that is a different decision with a different blast radius. */
const RESULT_DESCRIPTOR_KEYS = ["query", "url", "pattern"] as const;

/** ``web_search: openPage 'https://example.com'`` from a result payload, or
 *  undefined when it describes no call. Redaction and caps are the argument
 *  path's, unchanged — the descriptor is summarized as if it were args. */
export function sanitizeToolResultDescriptor(
  toolName: string,
  result: unknown,
): string | undefined {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return undefined;
  try {
    const record = result as Record<string, unknown>;
    const descriptor: Record<string, unknown> = {};
    for (const key of RESULT_DESCRIPTOR_KEYS) {
      const value = record[key];
      if (typeof value === "string") descriptor[key] = value;
    }
    if (Object.keys(descriptor).length === 0) return undefined;
    // Carried only to qualify a descriptor that already exists, never alone.
    if (typeof record.action === "string") descriptor.action = record.action;
    const name = collapseWhitespace(String(toolName || "tool")) || "tool";
    const summary = sanitizeToolSummary(name, descriptor);
    return summary === name ? undefined : summary;
  } catch {
    return undefined;
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
