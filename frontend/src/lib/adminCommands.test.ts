import { describe, expect, it } from "vitest";

import {
  extractAdminCommandQuery,
  getAdminCommandOptions,
  matchAdminCommandText,
} from "./adminCommands";

describe("admin commands", () => {
  it("matches agent DM admin commands", () => {
    for (const command of [
      "/help",
      "/new",
      "/start",
      "/reset",
      "/clear",
      "/usage",
      "/cb-usage",
    ] as const) {
      expect(matchAdminCommandText(`${command} now`)?.kind).toBe(command.slice(1));
    }
  });

  it("rejects unknown slash commands", () => {
    expect(matchAdminCommandText("/unknown")).toBeNull();
  });

  it("extracts slash command queries after the opening slash", () => {
    expect(extractAdminCommandQuery("/", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(extractAdminCommandQuery("/re", 3)).toEqual({ start: 0, end: 3, query: "re" });
    expect(extractAdminCommandQuery("/reset ", 7)).toBeNull();
    expect(extractAdminCommandQuery("hi /re", 6)).toBeNull();
  });

  it("filters slash command options", () => {
    expect(getAdminCommandOptions("").map((cmd) => cmd.command)).toEqual([
      "/new",
      "/start",
      "/reset",
      "/clear",
      "/usage",
      "/cb-usage",
      "/help",
    ]);
    expect(getAdminCommandOptions("re").map((cmd) => cmd.command)).toEqual(["/reset"]);
  });

  it("matches and filters the hyphenated /cb-usage command", () => {
    expect(matchAdminCommandText("/cb-usage")?.kind).toBe("cb-usage");
    expect(extractAdminCommandQuery("/cb-usage", 9)).toEqual({
      start: 0,
      end: 9,
      query: "cb-usage",
    });
    expect(getAdminCommandOptions("usage").map((cmd) => cmd.command)).toEqual([
      "/usage",
      "/cb-usage",
    ]);
  });
});
