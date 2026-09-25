import {describe, expect, it} from "vitest";

import {
    buildHermesSetupPrompt,
    buildOpenClawSetupPrompt,
    CLAWBITS_OPTIONAL_TOOLS,
    COMPANION_PLUGIN_SLUG,
    PLUGIN_SLUG,
} from "./agentPrompts";

describe("OpenClaw onboarding prompt", () => {
    it("installs and activates the channel and companion in safe order", () => {
        const prompt = buildOpenClawSetupPrompt(null, "signup-token-1");
        const channelInstall = `openclaw plugins install ${PLUGIN_SLUG} --accept-capabilities`;
        const companionInstall = `openclaw plugins install ${COMPANION_PLUGIN_SLUG} --accept-capabilities`;
        const signup = "openclaw clawbits signup";
        const ownership = "openclaw config set channels.clawbits.serviceOwner tools";

        expect(prompt).toContain(channelInstall);
        expect(prompt).toContain(companionInstall);
        expect(prompt.indexOf(channelInstall)).toBeLessThan(prompt.indexOf(companionInstall));
        expect(prompt.indexOf(companionInstall)).toBeLessThan(prompt.indexOf(signup));
        expect(prompt.indexOf(signup)).toBeLessThan(prompt.indexOf(ownership));
        expect(prompt.match(/openclaw clawbits signup/g)).toHaveLength(1);
        expect(prompt).not.toContain("--acknowledge-clawhub-risk");
        // OpenClaw 2026.8 refuses `--pin` for a `clawhub:` ref; only the comment may mention it.
        expect(channelInstall).not.toContain("--pin");
        expect(companionInstall).not.toContain("--pin");
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
        expect(prompt).toContain("openclaw clawbits version");
        expect(prompt).toContain("openclaw channels status --probe");
        expect(prompt).not.toContain("openclaw clawbits healthcheck");
    });
});

describe("Hermes onboarding prompt", () => {
    it("installs non-destructively, stops on an unused token, and verifies with doctor", () => {
        const prompt = buildHermesSetupPrompt(null, "signup-token-1");
        const install = prompt.split("\n").find((line) => line.startsWith("./extensions/hermes/reinstall.sh"));

        expect(install).toContain("reinstall.sh --endpoint");
        expect(install).toContain('--signup-token "signup-token-1"');
        expect(install).not.toContain(" -y");
        expect(prompt).toContain("grep -q -- '--restart-default' extensions/hermes/reinstall.sh");
        expect(prompt).toContain("checkout is too old");
        expect(prompt.indexOf("checkout is too old")).toBeLessThan(prompt.indexOf("./extensions/hermes/reinstall.sh --endpoint"));
        expect(prompt).not.toContain("reinstall.sh -y");
        expect(prompt).not.toContain("--reset -y ./");
        expect(prompt).toContain("Exit code 4");
        expect(prompt).toContain("--profile NAME");
        expect(prompt).toContain("--reset -y");
        expect(prompt).toContain("Exit code 3");
        expect(prompt).toContain("--restart-default");
        expect(prompt.trimEnd().endsWith("hermes clawbits doctor")).toBe(true);
        expect(prompt).not.toContain("hermes gateway start");
    });
});
