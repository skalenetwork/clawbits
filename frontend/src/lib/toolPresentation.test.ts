import { describe, expect, it } from "vitest";

import { formatDuration, toolPresentation } from "./toolPresentation";

describe("toolPresentation", () => {
  it("maps web search to a human 'Searching the web' verb", () => {
    expect(toolPresentation("web_search").verb).toBe("Searching the web");
    expect(toolPresentation("google_search").verb).toBe("Searching the web");
  });

  it("maps shell/command tools to 'Running'", () => {
    expect(toolPresentation("bash").verb).toBe("Running");
    expect(toolPresentation("run_command").verb).toBe("Running");
  });

  it("distinguishes reading from editing files", () => {
    expect(toolPresentation("read_file").verb).toBe("Reading");
    expect(toolPresentation("str_replace_editor").verb).toBe("Editing");
  });

  it("falls back to a generic verb for unknown / missing tools", () => {
    expect(toolPresentation("frobnicate_widget").verb).toBe("Running");
    expect(toolPresentation(undefined).verb).toBe("Running");
    expect(toolPresentation(null).verb).toBe("Running");
  });

  it("always resolves an icon", () => {
    expect(toolPresentation("web_search").icon).toBeTruthy();
    expect(toolPresentation("anything").icon).toBeTruthy();
  });
});

describe("formatDuration", () => {
  it("formats sub-second durations as milliseconds", () => {
    expect(formatDuration(340)).toBe("340ms");
  });

  it("formats single-digit seconds with one decimal", () => {
    expect(formatDuration(2140)).toBe("2.1s");
  });

  it("formats double-digit seconds without a decimal", () => {
    expect(formatDuration(23000)).toBe("23s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(65000)).toBe("1m 5s");
  });

  it("returns null for missing or invalid input", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(-5)).toBeNull();
  });
});
