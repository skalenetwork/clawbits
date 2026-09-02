import {describe, expect, it} from "vitest";

import {
    buildOpenClawSetupPrompt,
    CLAWBITS_OPTIONAL_TOOLS,
    COMPANION_PLUGIN_SLUG,
    PLUGIN_SLUG,
} from "./prompts";

if (typeof window === "undefined") {
    Object.defineProperty(globalThis, "window", {
        value: {location: {origin: "https://app.clawbits.test"}},
    });
}

describe("OpenClaw onboarding prompt", () => {
    it("installs and activates the channel and companion in safe order", () => {
        const prompt = buildOpenClawSetupPrompt(null, "signup-token-1");
        const channelInstall = `openclaw plugins install ${PLUGIN_SLUG} --pin`;
        const companionInstall = `openclaw plugins install ${COMPANION_PLUGIN_SLUG} --pin`;
        const signup = "openclaw clawbits signup";
        const ownership = "openclaw config set channels.clawbits.serviceOwner tools";

        expect(prompt).toContain(channelInstall);
        expect(prompt).toContain(companionInstall);
        expect(prompt.indexOf(channelInstall)).toBeLessThan(prompt.indexOf(companionInstall));
        expect(prompt.indexOf(companionInstall)).toBeLessThan(prompt.indexOf(signup));
        expect(prompt.indexOf(signup)).toBeLessThan(prompt.indexOf(ownership));
        expect(prompt.match(/openclaw clawbits signup/g)).toHaveLength(1);
        expect(prompt).not.toContain("--acknowledge-clawhub-risk");
    });

    it("merges every optional tool and verifies both runtimes", () => {
        const prompt = buildOpenClawSetupPrompt(null, "signup-token-1");

        for (const tool of CLAWBITS_OPTIONAL_TOOLS) expect(prompt).toContain(tool);
        expect(prompt).toContain("openclaw config get tools.alsoAllow --json");
        expect(prompt).toContain("new Set(");
        expect(prompt).toContain("openclaw config set tools.alsoAllow");
        expect(prompt).toContain("openclaw gateway restart");
        expect(prompt).toContain("openclaw plugins inspect clawbits --runtime");
        expect(prompt).toContain("openclaw plugins inspect clawbits-tools --runtime");
        expect(prompt).toContain("openclaw clawbits healthcheck");
    });
});
