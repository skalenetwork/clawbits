import { describe, expect, it } from "vitest";

import { pushTargetToPath, withoutHandledLinks } from "./push";

// The function reads window.location.origin; jsdom's own origin stands in for
// the app host, so the cases below are about origin *identity*, not the literal
// hostname. APP is the real one, used only where a mismatch is the point.
const APP = "https://app.clawbits.ai";
const HERE = window.location.origin;

describe("pushTargetToPath", () => {
  // The bug this exists for: the payload carries an absolute URL so a service
  // worker left over on the old apex opens the right host, but react-router
  // must still be handed a path.
  it("folds an absolute app URL down to a path", () => {
    expect(pushTargetToPath(`${HERE}/channels/abc`)).toBe("/channels/abc");
    expect(pushTargetToPath(`${HERE}/`)).toBe("/");
  });

  it("keeps the query and hash", () => {
    expect(pushTargetToPath(`${HERE}/channels/abc?post=1#p2`)).toBe(
      "/channels/abc?post=1#p2",
    );
  });

  it("passes a bare path through", () => {
    expect(pushTargetToPath("/channels/abc")).toBe("/channels/abc");
  });

  // Cross-origin -> null, so the caller hard-navigates instead of soft-routing
  // to a path on the wrong host. This is what a pre-cutover apex registration
  // looks like from inside the app.
  it("refuses a cross-origin target", () => {
    expect(pushTargetToPath(`${APP}/channels/abc`)).toBeNull();
    expect(pushTargetToPath("https://clawbits.ai/channels/abc")).toBeNull();
    expect(pushTargetToPath("https://evil.example/steal")).toBeNull();
  });

  // Anything that is not an absolute URL is a relative reference and resolves
  // against the app origin - which is the right answer for it, not an error.
  it("resolves a relative target against the app origin", () => {
    expect(pushTargetToPath("channels/abc")).toBe("/channels/abc");
  });
});

describe("withoutHandledLinks", () => {
  const params = new URLSearchParams("msg=42&widget=w1&tab=files");

  // A `?msg=` and a `?widget=` handled in one commit: each strip starts from the same render's params, so each
  // must drop both, or the second navigation brings the first one's param back.
  it("drops every param already acted on, whichever link strips", () => {
    expect(withoutHandledLinks(params, { msg: "42", widget: "w1" }).toString()).toBe("tab=files");
  });

  it("keeps a param not acted on yet, or since changed to another value", () => {
    expect(withoutHandledLinks(params, { msg: "42", widget: null }).toString()).toBe("widget=w1&tab=files");
    expect(withoutHandledLinks(params, { msg: "7", widget: "w1" }).toString()).toBe("msg=42&tab=files");
  });

  it("leaves the params it was given alone", () => {
    withoutHandledLinks(params, { msg: "42", widget: "w1" });
    expect(params.toString()).toBe("msg=42&widget=w1&tab=files");
  });
});
