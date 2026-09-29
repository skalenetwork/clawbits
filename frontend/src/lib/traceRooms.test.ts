import { describe, expect, it } from "vitest";
import { SourceCodeIcon } from "@hugeicons/core-free-icons";

import { type Room, roomOf, stepLabel } from "@/lib/traceRooms";

describe("stepLabel", () => {
  it.each<[string, Room, string, string]>([
    ["exec: 'linear issue list --state triage'", "run", "linear issue list", "--state triage"],
    ["exec: 'cd /tmp && ls -la'", "run", "cd", "/tmp && ls -la"],
    ["gh pr list", "run", "gh pr list", ""],
    ["exec: ''", "run", "exec", ""],
    ["read: '/home/node/.openclaw/workspace/skills/linear/SKILL.md'", "read", "SKILL.md", "…/skills/linear"],
    ["read: '/home/node/notes.md'", "read", "notes.md", "…"],
    ["read: '/etc/hosts'", "read", "hosts", "/etc"],
    ["write: 'notes/today.md'", "write", "today.md", "notes"],
    ["ls: '/home/node/.openclaw/workspace/skills/'", "find", "skills/", "…"],
    ["exec: '/usr/local/bin/prep.sh'", "run", "prep.sh", "/usr/local/bin"],
    ["sql_query: 'SELECT * FROM issues'", "read", "SELECT * FROM issues", ""],
    ["grep: 'TODO|FIXME'", "find", "TODO|FIXME", ""],
    ["web_search: openPage 'https://example.com/docs'", "reach", "https://example.com/docs", "open page"],
    ["web_search: search 'skale gas price'", "reach", "skale gas price", "search"],
    ["web_search: skale gas price", "reach", "skale gas price", ""],
    ["apply_patch", "write", "apply_patch", ""],
    [
      "exec: 'find /home/node/.openclaw/workspace/skills/… -maxdepth 2 -type…",
      "run",
      "find",
      "/home/node/.openclaw/workspace/skills/… -maxdepth 2 -type…",
    ],
    ["read: '/home/node/.openclaw/workspace/skills/linear/SKI…", "read", "SKI…", "…/skills/linear"],
  ])("%s", (label, room, head, tail) => {
    expect(stepLabel(label, room)).toEqual({ head, tail });
  });
});

describe("roomOf", () => {
  it("draws the run room with source code, not a terminal box", () => {
    expect(roomOf("exec").icon).toBe(SourceCodeIcon);
    expect(roomOf("bash").room).toBe("run");
  });
});
