import type {PluginVersionCheck} from "@/lib/api";
import type {ReefImage} from "@/lib/reefApi";

export type CompatibilityQueryState = "pending" | "error" | "success";

export interface ImageCompatibility {
    problem: string | null;
    ready: boolean;
    checking: boolean;
}

/** Fail closed before Reef spends a signup token. A running VM is not proof its
 *  baked Clawbits component can pass this server's enrollment gate. */
export function imageCompatibility({
    runtime,
    imagesState,
    selectedImage,
    verdictState,
    verdict,
}: {
    runtime: string | null;
    imagesState: CompatibilityQueryState;
    selectedImage: ReefImage | null;
    verdictState: CompatibilityQueryState;
    verdict: PluginVersionCheck | undefined;
}): ImageCompatibility {
    if (runtime === null) return {problem: null, ready: false, checking: false};
    if (imagesState === "error") {
        return {problem: "Couldn't inspect this Reef's agent images.", ready: false, checking: false};
    }
    if (imagesState !== "success") return {problem: null, ready: false, checking: true};
    if (selectedImage === null) {
        return {
            problem: "This Reef has no image for the selected runtime.",
            ready: false,
            checking: false,
        };
    }
    const version = selectedImage.component_version ?? null;
    if (version === null) {
        return {
            problem: "This image does not report its Clawbits component version. Rebuild it before creating an agent.",
            ready: false,
            checking: false,
        };
    }
    if (verdictState === "error") {
        return {
            problem: "Couldn't verify this image against the Clawbits server. Reload and try again.",
            ready: false,
            checking: false,
        };
    }
    if (verdictState !== "success") return {problem: null, ready: false, checking: true};
    if (!verdict) {
        return {
            problem: "The Clawbits server returned no image compatibility verdict.",
            ready: false,
            checking: false,
        };
    }
    if (verdict.plugin_version === null) {
        return {
            problem: `This image reports an invalid Clawbits version (${version}). Rebuild it before creating an agent.`,
            ready: false,
            checking: false,
        };
    }
    if (!verdict.supported) {
        return {
            problem: `This image has Clawbits ${version}; this server requires ${verdict.min_plugin_version} or newer. Rebuild and activate the Reef image first.`,
            ready: false,
            checking: false,
        };
    }
    return {problem: null, ready: true, checking: false};
}
