/** Provider id -> brand glyph + tile washes (mirrors reef/admin-ui's picker
 *  language). Washes use each brand's current palette: Anthropic clay #D97757;
 *  OpenAI has been officially monochrome since its 2025 rebrand, so its tile
 *  carries the signature product green #10A37F; Gemini brand blue #4285F4;
 *  Ollama is monochrome (neutral wash). Unknown ids (a future registry entry)
 *  get the neutral wash + no glyph — the tile still renders. */
import type React from "react";
import {AnthropicIcon, CodexColorIcon, GeminiIcon, NearAiIcon, OllamaIcon, OpenAiIcon, OpenRouterIcon} from "@/components/ProviderIcons";

export interface ProviderBrand {
    Glyph: React.ComponentType<{className?: string}> | null;
    /** CSS background for the icon's app-tile (the OptionCard language). */
    tile: string;
    /** One-line descriptor under the provider name. */
    line: string;
}

const NEUTRAL_TILE = "linear-gradient(180deg, #404040, #171717)";

export const PROVIDER_BRANDS: Record<string, ProviderBrand> = {
    anthropic: {
        Glyph: AnthropicIcon,
        tile: "linear-gradient(180deg, #D97757, #C4633D)",
        line: "Claude models",
    },
    openai: {
        Glyph: OpenAiIcon,
        tile: "linear-gradient(180deg, #10A37F, #0C8A6B)",
        line: "GPT models",
    },
    // ChatGPT-subscription (Codex OAuth): the owner signs in with their ChatGPT
    // plan inside the VM after launch. The Codex mark on a white tile (its own
    // app-icon look) sets it apart from the monochrome API-key OpenAI tile above.
    "openai-codex": {
        Glyph: CodexColorIcon,
        tile: "#ffffff",
        line: "Use your ChatGPT plan",
    },
    gemini: {
        Glyph: GeminiIcon,
        tile: "linear-gradient(180deg, #4285F4, #2F6BD8)",
        line: "Gemini models",
    },
    // NEAR Cloud AI (cloud-api.near.ai): OpenAI-compatible hosting for open
    // models. NEAR's official mark is black-and-white: white "N" on a black
    // tile (slightly off the Clawbits picker black so they read apart).
    nearai: {
        Glyph: NearAiIcon,
        tile: "linear-gradient(180deg, #1f1f1f, #000000)",
        line: "GLM, DeepSeek & open models",
    },
    // OpenRouter (openrouter.ai): one key across every hosted model, ids as
    // vendor/model slugs. The brand is monochrome; a dark slate wash keeps it
    // apart from NEAR's black and the neutral ollama tile.
    openrouter: {
        Glyph: OpenRouterIcon,
        tile: "linear-gradient(180deg, #333a4d, #171b26)",
        line: "One key, many models",
    },
    ollama: {
        Glyph: OllamaIcon,
        tile: NEUTRAL_TILE,
        line: "Local, on your own server",
    },
};

export function providerBrand(id: string): ProviderBrand {
    return PROVIDER_BRANDS[id] ?? {Glyph: null, tile: NEUTRAL_TILE, line: ""};
}
