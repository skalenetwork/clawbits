import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { Analytics } from "./Analytics";

const SCRIPT_SELECTOR = "script[data-clawbits-analytics]";

function renderOn(hostname: string) {
  vi.stubGlobal("location", { hostname });
  render(<Analytics />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.querySelector(SCRIPT_SELECTOR)?.remove();
});

describe("Analytics", () => {
  it("injects the Umami script on the production host", () => {
    renderOn("clawbits.ai");
    const script = document.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR);
    expect(script).not.toBeNull();
    expect(script?.src).toBe("https://cloud.umami.is/script.js");
    expect(script?.dataset.websiteId).toBe("3b3f10a0-3d8a-4196-b692-1442deded2d9");
    expect(script?.dataset.domains).toBe("clawbits.ai");
  });

  it("does not inject on the staging host", () => {
    renderOn("freeclaws.ai");
    expect(document.querySelector(SCRIPT_SELECTOR)).toBeNull();
  });

  it("does not inject on a dev host", () => {
    renderOn("localhost");
    expect(document.querySelector(SCRIPT_SELECTOR)).toBeNull();
  });

  it("injects at most once across remounts", () => {
    vi.stubGlobal("location", { hostname: "clawbits.ai" });
    render(<Analytics />);
    render(<Analytics />);
    expect(document.querySelectorAll(SCRIPT_SELECTOR)).toHaveLength(1);
  });
});
