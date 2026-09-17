import { describe, expect, it } from "vitest";
import { formatAgentVersion, parseAgentImage } from "./formatting";

describe("parseAgentImage", () => {
  it("reads the runtime, engine and plugin off a scheme tag", () => {
    expect(
      parseAgentImage("ghcr.io/skalenetwork/clawbits-openclaw:oc2026.9.4-pl0.17.24-g72359f5"),
    ).toEqual({
      tag: "oc2026.9.4-pl0.17.24-g72359f5",
      label: "clawbits-openclaw:oc2026.9.4-pl0.17.24-g72359f5",
      scheme: { runtime: "openclaw", engine: "2026.9.4", plugin: "0.17.24" },
    });
  });

  it("takes the commit as optional and knows every runtime prefix", () => {
    expect(parseAgentImage("ghcr.io/x/clawbits-hermes:hm1.2-pl0.17.24").scheme).toEqual({
      runtime: "hermes",
      engine: "1.2",
      plugin: "0.17.24",
    });
    expect(parseAgentImage("ghcr.io/x/clawbits-ironclaw:ic0.4.1-pl1.0.0").scheme?.runtime).toBe(
      "ironclaw",
    );
  });

  it("keeps an off-scheme tag whole, and a registry port out of it", () => {
    expect(parseAgentImage("ghcr.io/x/clawbits-openclaw:nightly")).toMatchObject({
      tag: "nightly",
      scheme: null,
    });
    expect(parseAgentImage("localhost:5000/clawbits-openclaw:oc1.0-pl2.0").scheme?.engine).toBe(
      "1.0",
    );
  });

  it("shortens a digest and leaves a digest-pinned reference untagged", () => {
    expect(parseAgentImage("ghcr.io/skalenetwork/openclaw@sha256:9f644431c0de")).toMatchObject({
      tag: "",
      label: "openclaw@9f64443",
    });
    expect(parseAgentImage("openclaw")).toMatchObject({ tag: "", label: "openclaw" });
  });

  it("says nothing about an agent whose host reported no image", () => {
    expect(parseAgentImage("")).toEqual({ tag: "", label: "", scheme: null });
  });
});

describe("formatAgentVersion", () => {
  const image = parseAgentImage("ghcr.io/x/clawbits-openclaw:oc2026.9.4-pl0.17.24-g72359f5");

  it("prefers the plugin version the agent reports itself", () => {
    expect(formatAgentVersion(image, "0.18.0")).toBe("2026.9.4 · 0.18.0");
  });

  it("falls back to the plugin baked into the tag", () => {
    expect(formatAgentVersion(image)).toBe("2026.9.4 · 0.17.24");
    expect(formatAgentVersion(image, null)).toBe("2026.9.4 · 0.17.24");
    expect(formatAgentVersion(image, "")).toBe("2026.9.4 · 0.17.24");
  });

  it("renders an off-scheme tag verbatim", () => {
    expect(formatAgentVersion(parseAgentImage("ghcr.io/x/openclaw:nightly"), "0.18.0")).toBe(
      "nightly",
    );
  });

  it("labels a reference that carries no tag", () => {
    expect(formatAgentVersion(parseAgentImage("ghcr.io/openclaw/openclaw@sha256:6d5fecea52bd"))).toBe(
      "openclaw@6d5fece",
    );
  });
});
