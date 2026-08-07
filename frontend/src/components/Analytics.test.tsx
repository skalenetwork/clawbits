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
    expect(script?.dataset.domains).toBe("clawbits.ai,app.clawbits.ai");
  });

  // Where the app lives after the Phase 6 apex cutover. Tracked from the same
  // website ID as the marketing site so landing -> signup is one funnel; this
  // asserts the app half of that pair does not go dark when the host changes.
  it("injects on the post-cutover app host", () => {
    renderOn("app.clawbits.ai");
    expect(document.querySelector(SCRIPT_SELECTOR)).not.toBeNull();
  });

  // The marketing site carries its own tag (web/src/layouts/Base.astro). If the
  // SPA ever gets served from a preview host it must not double-count.
  it("does not inject on a preview host", () => {
    renderOn("preview.clawbits.ai");
    expect(document.querySelector(SCRIPT_SELECTOR)).toBeNull();
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
