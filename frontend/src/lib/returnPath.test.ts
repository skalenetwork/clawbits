/**
 * The client half of the ``?next=`` validator. Deliberately mirrors
 * tests/fastapi/test_workos_social.py - the OAuth leg validates in Python and
 * the in-SPA flows validate here, so both need the same hostile cases.
 */
import { describe, expect, it } from "vitest";
import { captureReturnPath, loginPathFor, safeReturnPath } from "./returnPath";

describe("safeReturnPath", () => {
  it.each([
    ["//evil.com", "protocol-relative is another origin"],
    ["/\\evil.com", "browsers normalise the backslash"],
    ["https://evil.com/", "absolute"],
    ["javascript:alert(1)", "scheme, not rooted"],
    ["agents", "not rooted"],
    ["", "empty"],
    [null, "absent"],
    ["/agents\nLocation: https://evil.com", "control character"],
    ["/login", "would loop against GuestOnly"],
    ["/login?next=%2Fx", "same, with a query"],
    ["/verify-email", "intermediate auth route"],
    [`/${"a".repeat(600)}`, "absurd length"],
    /* Both tuple members are declared, because `it.each` spreads the WHOLE row
     * into the callback - a one-parameter callback does not type-check against
     * a two-column table. The reason rides into the test name via the second
     * `%s`, and `_why` is underscored so `noUnusedParameters` lets it be. */
  ])("rejects %s - %s", (raw: string | null, _why: string) => {
    expect(safeReturnPath(raw)).toBeNull();
  });

  it.each([
    "/agents",
    "/agents/abc-123/manage",
    "/channels/general?highlight=42",
    "/agents?utm_source=clawbits.ai#top",
    "/logins", // NOT /login - the prefix guard must not over-match
  ])("accepts %s", (raw) => {
    expect(safeReturnPath(raw)).toBe(raw);
  });
});

describe("captureReturnPath", () => {
  it("keeps query and hash so a deep link survives intact", () => {
    expect(
      captureReturnPath({ pathname: "/agents/a", search: "?tab=env", hash: "#k" }),
    ).toBe("/agents/a?tab=env#k");
  });

  it("returns null for the default landing, so the common case stays clean", () => {
    expect(captureReturnPath({ pathname: "/home", search: "", hash: "" })).toBeNull();
    expect(captureReturnPath({ pathname: "/", search: "", hash: "" })).toBeNull();
  });
});

describe("loginPathFor", () => {
  it("omits the parameter when there is nothing to carry", () => {
    expect(loginPathFor(null)).toBe("/login");
  });

  it("encodes the destination", () => {
    expect(loginPathFor("/agents?a=1")).toBe("/login?next=%2Fagents%3Fa%3D1");
  });
});
