import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AdminCommandGlyph } from "./AdminCommandGlyph";
import { ADMIN_COMMANDS } from "@/lib/adminCommands";

describe("AdminCommandGlyph", () => {
  it("renders an icon tile for every admin command kind", () => {
    for (const cmd of ADMIN_COMMANDS) {
      const { container, unmount } = render(<AdminCommandGlyph kind={cmd.kind} />);
      // Hugeicons renders the glyph as an inline <svg>; a missing/typo'd icon
      // import would render nothing.
      expect(container.querySelector("svg"), cmd.kind).not.toBeNull();
      unmount();
    }
  });

  it("tints destructive commands with the destructive hue", () => {
    for (const kind of ["reset", "clear"] as const) {
      const { container, unmount } = render(<AdminCommandGlyph kind={kind} />);
      expect(container.firstElementChild?.className).toContain("text-destructive");
      unmount();
    }
  });

  it("tints read-only insight commands with the mention hue", () => {
    for (const kind of ["usage", "cb-usage"] as const) {
      const { container, unmount } = render(<AdminCommandGlyph kind={kind} />);
      expect(container.firstElementChild?.className).toContain("text-mention");
      unmount();
    }
  });

  it("keeps create/continue commands neutral (no semantic hue)", () => {
    const { container } = render(<AdminCommandGlyph kind="new" />);
    const cls = container.firstElementChild?.className ?? "";
    expect(cls).not.toContain("text-destructive");
    expect(cls).not.toContain("text-mention");
  });
});
