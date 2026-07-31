import {
  CommandLineIcon,
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

// A human verb + icon for an agent tool, so the activity line reads
// "Searching the web…" / "Running…" instead of a raw function name. The agent
// self-reports arbitrary tool names (embedded harness tools, MCP tools, custom
// plugins), so matching is keyword-based with a generic fallback — we never
// promise a nicer label than we can honestly infer from the name.
export interface ToolPresentation {
  icon: IconSvgElement;
  /** Present-continuous action shown while the tool runs. */
  verb: string;
}

const GENERIC: ToolPresentation = { icon: Wrench01Icon, verb: "Running" };

// Ordered most-specific first; the first regex to match the normalised tool
// name wins. Names are normalised by turning `_ - .` separators into spaces so
// `\b` word boundaries work on tool tokens (`read_file` → `read file`) — this
// keeps short keywords (`cat`, `ls`, `sh`) from matching mid-word, e.g.
// `concatenate` must NOT read as the `cat` tool.
const RULES: { test: RegExp; icon: IconSvgElement; verb: string }[] = [
  { test: /\bweb ?search\b|\bgoogle\b|\bbrave\b|\bduckduckgo\b|\bserp\b/, icon: Search01Icon, verb: "Searching the web" },
  { test: /\bbrowse\b|\bbrowser\b|\bnavigate\b|open url|\bvisit\b|puppeteer|playwright/, icon: Globe02Icon, verb: "Browsing" },
  { test: /\bhttp\b|\bfetch\b|\brequest\b|\bcurl\b|web fetch|\burl\b|\bscrape\b/, icon: Globe02Icon, verb: "Fetching" },
  { test: /generate image|image gen|\bdall|render image|\bdraw\b|diffusion/, icon: Image01Icon, verb: "Generating an image" },
  { test: /\bsql\b|database|postgres|query db|sqlite|mongo/, icon: Database01Icon, verb: "Querying the database" },
  { test: /\bemail\b|\bmail\b|\bsmtp\b|gmail|send message/, icon: Mail01Icon, verb: "Sending mail" },
  { test: /\bgrep\b|\bglob\b|\bfind\b|list dir|\bls\b|search file/, icon: Search01Icon, verb: "Searching files" },
  { test: /\bread\b|\bcat\b|\bview\b|get file|open file/, icon: File01Icon, verb: "Reading" },
  { test: /\bwrite\b|create file|\bsave\b|str replace|\bedit\b|editor|\bpatch\b|\bapply\b/, icon: FileEditIcon, verb: "Editing" },
  { test: /\bbash\b|\bshell\b|\bexec\b|\bterminal\b|\bcommand\b|run command|\bzsh\b|\bsh\b/, icon: CommandLineIcon, verb: "Running" },
  { test: /\bpython\b|\bnode\b|\bcode\b|\bexecute\b|\brepl\b|jupyter|interpreter|\bcompile\b/, icon: SourceCodeIcon, verb: "Running code" },
];

/** Resolve a tool name to a display icon + verb. */
export function toolPresentation(tool: string | null | undefined): ToolPresentation {
  if (!tool) return GENERIC;
  const norm = tool.toLowerCase().replace(/[_\-.]+/g, " ");
  for (const rule of RULES) {
    if (rule.test.test(norm)) return { icon: rule.icon, verb: rule.verb };
  }
  return GENERIC;
}

/** Compact human duration for a tool's elapsed time. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${String(m)}m ${String(rem)}s`;
}
