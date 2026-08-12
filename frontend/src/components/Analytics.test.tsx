import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { Analytics } from "./Analytics";
import { BEFORE_SEND, beforeSendPayload } from "../lib/analytics";

const SCRIPT_SELECTOR = "script[data-clawbits-analytics]";

function renderOn(hostname: string) {
  vi.stubGlobal("location", { hostname });
  render(<Analytics />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.querySelector(SCRIPT_SELECTOR)?.remove();
  window[BEFORE_SEND] = undefined;
});

describe("Analytics", () => {
  it("injects the Umami script on the production host", () => {
    renderOn("app.clawbits.ai");
    const script = document.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR);
    expect(script).not.toBeNull();
    expect(script?.src).toBe("https://cloud.umami.is/script.js");
    expect(script?.dataset.websiteId).toBe("3b3f10a0-3d8a-4196-b692-1442deded2d9");
    expect(script?.dataset.domains).toBe("app.clawbits.ai");
  });

  // The tracker looks the hook up by NAME on window at send time. Wiring one
  // without the other is the silent failure: events still flow, unsanitized.
  it("installs the payload sanitizer before the script", () => {
    renderOn("app.clawbits.ai");
    const script = document.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR);
    expect(script?.dataset.beforeSend).toBe(BEFORE_SEND);
    expect(window[BEFORE_SEND]).toBe(beforeSendPayload);
  });

  // The apex is the marketing site since the 2026-08-12 cutover and carries its
  // own tag (web/src/layouts/Base.astro) - the app must not double-count it.
  it("does not inject on the marketing apex", () => {
    renderOn("clawbits.ai");
    expect(document.querySelector(SCRIPT_SELECTOR)).toBeNull();
  });

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
    vi.stubGlobal("location", { hostname: "app.clawbits.ai" });
    render(<Analytics />);
    render(<Analytics />);
    expect(document.querySelectorAll(SCRIPT_SELECTOR)).toHaveLength(1);
  });
});
