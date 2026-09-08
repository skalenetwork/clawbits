import {describe, expect, it} from "vitest";

import type {PluginVersionCheck} from "@/lib/api";
import type {ReefImage} from "@/lib/reefApi";
import {imageCompatibility} from "./imageCompatibility";

function image(version: string | null): ReefImage {
    return {
        tag: "reef-oc:plugin",
        image_id: "sha256:test",
        created_at: null,
        size_bytes: 1,
        reef_image_version: null,
        runtime_version: "2026.6.10",
        component_version: version,
        is_active: true,
        agent_type: "openclaw",
    };
}

function verdict(supported: boolean): PluginVersionCheck {
    return {
        supported,
        plugin_version: "0.15.11",
        min_plugin_version: "0.17.0",
        message: null,
    };
}

describe("imageCompatibility", () => {
    it("blocks the stale image that would receive enrollment 426", () => {
        const result = imageCompatibility({
            runtime: "openclaw",
            imagesState: "success",
            selectedImage: image("0.15.11"),
            verdictState: "success",
            verdict: verdict(false),
        });
        expect(result.ready).toBe(false);
        expect(result.problem).toContain("requires 0.17.0 or newer");
    });

    it("allows a server-supported image", () => {
        expect(imageCompatibility({
            runtime: "openclaw",
            imagesState: "success",
            selectedImage: image("0.17.21"),
            verdictState: "success",
            verdict: {...verdict(true), plugin_version: "0.17.21"},
        })).toEqual({problem: null, ready: true, checking: false});
    });

    it("fails closed for an unversioned image", () => {
        const result = imageCompatibility({
            runtime: "openclaw",
            imagesState: "success",
            selectedImage: image(null),
            verdictState: "pending",
            verdict: undefined,
        });
        expect(result.ready).toBe(false);
        expect(result.problem).toContain("does not report");
    });

    it("fails closed when the server cannot parse the image version", () => {
        const result = imageCompatibility({
            runtime: "openclaw",
            imagesState: "success",
            selectedImage: image("dev"),
            verdictState: "success",
            verdict: {...verdict(true), plugin_version: null},
        });
        expect(result.ready).toBe(false);
        expect(result.problem).toContain("invalid Clawbits version");
    });
});
