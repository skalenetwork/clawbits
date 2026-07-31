import { describe, expect, it } from "vitest";

import { controlUiAuthUrl, surfaceAuthUrl, terminalAuthUrl } from "./reefApi";

// These are pure string builders — no network, no live agent. All values below
// are placeholders; never put a real gateway token / terminal password here.
describe("terminalAuthUrl", () => {
  const TOKEN = "test-terminal-password-000";

  it("embeds the fixed `reef` user + password over the https tunnel so ttyd never prompts", () => {
    const url = "https://reef.example.test/s/deadbeefdeadbeefdeadbeefdeadbeef/";
    expect(terminalAuthUrl(url, TOKEN)).toBe(
      `https://reef:${TOKEN}@reef.example.test/s/deadbeefdeadbeefdeadbeefdeadbeef/`,
    );
  });

  it("still embeds over local http (dev DirectPort exposure)", () => {
    expect(terminalAuthUrl("http://127.0.0.1:40002/", TOKEN)).toBe(
      `http://reef:${TOKEN}@127.0.0.1:40002/`,
    );
  });

  it("url-encodes credential-breaking characters in the password", () => {
    // A password with `@`/`:`/`/` must not corrupt the URL authority.
    expect(terminalAuthUrl("https://host/s/d/", "a@b:c/d")).toBe(
      "https://reef:a%40b%3Ac%2Fd@host/s/d/",
    );
  });

  it("returns the URL unchanged when there is no password", () => {
    expect(terminalAuthUrl("https://host/s/d/", null)).toBe("https://host/s/d/");
    expect(terminalAuthUrl("https://host/s/d/", "")).toBe("https://host/s/d/");
  });

  it("leaves a non-http(s) URL untouched", () => {
    expect(terminalAuthUrl("ws://host/", TOKEN)).toBe("ws://host/");
  });
});

describe("controlUiAuthUrl", () => {
  it("appends the gateway token as a client-only `#token=` fragment", () => {
    expect(controlUiAuthUrl("https://host/s/d/", "test-token")).toBe(
      "https://host/s/d/#token=test-token",
    );
    // Trailing slashes are normalized so the fragment lands on a clean path.
    expect(controlUiAuthUrl("https://host/s/d//", "test-token")).toBe(
      "https://host/s/d/#token=test-token",
    );
  });

  it("returns the URL unchanged when there is no token", () => {
    expect(controlUiAuthUrl("https://host/s/d/", null)).toBe("https://host/s/d/");
  });
});

describe("surfaceAuthUrl", () => {
  // Regression: a hermes dashboard sits behind nginx BASIC-AUTH — a `#token=`
  // fragment is never sent to the server, so one-click open landed on the
  // browser's 401 prompt. The hermes branch must embed creds terminal-style.
  it("uses basic-auth creds for a hermes dashboard", () => {
    expect(surfaceAuthUrl("hermes", "https://host/s/d/", "test-pw")).toBe(
      "https://reef:test-pw@host/s/d/",
    );
  });

  it("keeps the `#token=` fragment for openclaw (and unknown kinds)", () => {
    expect(surfaceAuthUrl("openclaw", "https://host/s/d/", "test-token")).toBe(
      "https://host/s/d/#token=test-token",
    );
    expect(surfaceAuthUrl(null, "https://host/s/d/", "test-token")).toBe(
      "https://host/s/d/#token=test-token",
    );
  });

  it("returns the URL unchanged when there is no secret", () => {
    expect(surfaceAuthUrl("hermes", "https://host/s/d/", null)).toBe("https://host/s/d/");
    expect(surfaceAuthUrl("openclaw", "https://host/s/d/", null)).toBe("https://host/s/d/");
  });
});
