export type AdminCommandKind = 'help' | 'new';

export interface AdminCommandMatch {
  kind: AdminCommandKind;
  command: string;
  description: string;
}

const ADMIN_COMMAND_DESCRIPTIONS: Record<AdminCommandKind, string> = {
  help: 'Show admin command help',
  new: 'Start a fresh agent session',
};

export function matchAdminCommandText(text: string): AdminCommandMatch | null {
  const trimmed = text.trim();
  const match = /^\/(help|new)(?:\s|$)/iu.exec(trimmed);
  if (!match) return null;
  const rawKind = match[1]?.toLowerCase();
  if (rawKind !== 'help' && rawKind !== 'new') return null;
  const kind: AdminCommandKind = rawKind;
  return {
    kind,
    command: trimmed,
    description: ADMIN_COMMAND_DESCRIPTIONS[kind],
  };
}

export function isAdminCommandText(text: string): boolean {
  return matchAdminCommandText(text) != null;
}
