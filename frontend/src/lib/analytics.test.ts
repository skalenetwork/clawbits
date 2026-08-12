import { describe, expect, it } from "vitest";
import { beforeSendPayload, sanitizeUrl } from "./analytics";

const APP = "https://app.clawbits.ai";

describe("sanitizeUrl", () => {
  // The one this exists for. /login?email= is a real route in LoginPage.tsx.
  it("drops an email address from the query string", () => {
    expect(sanitizeUrl(`${APP}/login?email=someone%40example.com`)).toBe(`${APP}/login`);
    expect(sanitizeUrl(`${APP}/verify-email?email=someone%40example.com`)).toBe(
      `${APP}/verify-email`,
    );
  });

  it("drops unknown parameters rather than allowlisting known-bad ones", () => {
    expect(sanitizeUrl(`${APP}/login?code=123456&token=abc&next=/home`)).toBe(`${APP}/login`);
  });

  // Without this the landing -> app hop is unmeasurable: the session id is
  // hostname-scoped, so the campaign on the URL is the only thing that crosses.
  it("keeps utm parameters", () => {
    expect(sanitizeUrl(`${APP}/login?utm_source=clawbits.ai&utm_medium=referral&email=a%40b.c`)).toBe(
      `${APP}/login?utm_source=clawbits.ai&utm_medium=referral`,
    );
  });

  it("collapses identifiers in the path", () => {
    expect(sanitizeUrl(`${APP}/channels/6f1b4501-6a53-5e97-97db-0bc4a4f4a3ea`)).toBe(
      `${APP}/channels/:id`,
    );
    expect(sanitizeUrl(`${APP}/agents/42/automations/7`)).toBe(`${APP}/agents/:id/automations/:id`);
  });

  it("leaves ordinary routes alone", () => {
    expect(sanitizeUrl(`${APP}/settings/notifications`)).toBe(`${APP}/settings/notifications`);
  });

  it("keeps a relative url relative", () => {
    expect(sanitizeUrl("/channels/6f1b4501-6a53-5e97-97db-0bc4a4f4a3ea?email=a%40b.c")).toBe(
      "/channels/:id",
    );
  });

  it("returns a safe placeholder for an unparseable url", () => {
    expect(sanitizeUrl("http://[")).toBe("/");
  });
});

describe("beforeSendPayload", () => {
  it("sanitizes url and referrer and returns the payload", () => {
    const out = beforeSendPayload("event", {
      url: `${APP}/login?email=a%40b.c`,
      referrer: `${APP}/channels/6f1b4501-6a53-5e97-97db-0bc4a4f4a3ea`,
      title: "(3) Clawbits",
    });
    expect(out.url).toBe(`${APP}/login`);
    expect(out.referrer).toBe(`${APP}/channels/:id`);
    // The unread count would otherwise be a row per badge value.
    expect(out.title).toBe("Clawbits");
  });

  it("leaves a payload without url or referrer untouched", () => {
    expect(beforeSendPayload("event", { name: "signin-complete" })).toEqual({
      name: "signin-complete",
    });
  });
});
