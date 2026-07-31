export type AdminCommandKind =
  | "help"
  | "new"
  | "start"
  | "reset"
  | "clear"
  | "usage"
  | "cb-usage";

/** Grouping used by the slash-command menu — one section header per category. */
export type AdminCommandCategory = "session" | "usage-help";

export interface AdminCommandDefinition {
  kind: AdminCommandKind;
  command: `/${AdminCommandKind}`;
  description: string;
  category: AdminCommandCategory;
}

export interface AdminCommandMatch {
  kind: AdminCommandKind;
  command: string;
  description: string;
}

export interface AdminCommandQuery {
  start: number;
  end: number;
  query: string;
}

// Order is meaningful: the menu renders section headers by walking this list in
// order, so entries are grouped by `category` (all "session" first, then
// "usage-help"). Keyboard nav also indexes this order, so it must match what the
// menu paints top-to-bottom.
export const ADMIN_COMMANDS: readonly AdminCommandDefinition[] = [
  { kind: "new", command: "/new", description: "Start a fresh agent session", category: "session" },
  { kind: "start", command: "/start", description: "Start a fresh agent session", category: "session" },
  { kind: "reset", command: "/reset", description: "Reset the agent session", category: "session" },
  { kind: "clear", command: "/clear", description: "Clear the agent session", category: "session" },
  { kind: "usage", command: "/usage", description: "Show agent token & cost usage", category: "usage-help" },
  { kind: "cb-usage", command: "/cb-usage", description: "Show remaining CB_TOKENS", category: "usage-help" },
  { kind: "help", command: "/help", description: "Show admin command help", category: "usage-help" },
];

export function matchAdminCommandText(text: string): AdminCommandMatch | null {
  const trimmed = text.trim();
  const match = /^\/([a-z][a-z-]*)(?:\s|$)/iu.exec(trimmed);
  if (!match) return null;
  const rawKind = match[1]?.toLowerCase();
  const def = ADMIN_COMMANDS.find((cmd) => cmd.kind === rawKind);
  if (!def) return null;
  return {
    kind: def.kind,
    command: trimmed,
    description: def.description,
  };
}

export function extractAdminCommandQuery(text: string, caretPos: number): AdminCommandQuery | null {
  const pos = Math.max(0, Math.min(caretPos, text.length));
  const match = /^\/[A-Za-z-]*(?=\s|$)/u.exec(text);
  if (!match) return null;
  const end = match[0].length;
  if (pos < 1 || pos > end) return null;
  return {
    start: 0,
    end,
    query: text.slice(1, pos).toLowerCase(),
  };
}

export function getAdminCommandOptions(query: string): readonly AdminCommandDefinition[] {
  const q = query.trim().toLowerCase().replace(/^\//u, "");
  if (!q) return ADMIN_COMMANDS;
  return ADMIN_COMMANDS.filter(
    (cmd) => cmd.kind.startsWith(q) || cmd.kind.includes(q),
  );
}
