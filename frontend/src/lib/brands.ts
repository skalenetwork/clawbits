/** Provider id to brand glyph and one flat tile color: the brand's own hue, or
 *  its product color where the brand is monochrome (OpenAI green, Ollama
 *  neutral). Unknown ids get the neutral tile and no glyph. */
import type {ComponentType} from "react";
import {AnthropicIcon, CodexColorIcon, GeminiIcon, NearAiIcon, OllamaIcon, OpenAiIcon, OpenRouterIcon} from "@/components/ProviderIcons";

interface ProviderBrand {
    Glyph?: ComponentType<{className?: string}>;
    tile: string;
    label?: string;
}

const NEUTRAL_TILE = "#262626";
const GEMINI: ProviderBrand = {Glyph: GeminiIcon, tile: "#4285F4", label: "Google"};

const PROVIDER_BRANDS: Record<string, ProviderBrand> = {
    anthropic: {Glyph: AnthropicIcon, tile: "#D97757", label: "Anthropic"},
    openai: {Glyph: OpenAiIcon, tile: "#10A37F", label: "OpenAI"},
    "openai-codex": {Glyph: CodexColorIcon, tile: "#ffffff", label: "Codex"},
    gemini: GEMINI,
    google: GEMINI,
    nearai: {Glyph: NearAiIcon, tile: "#000000", label: "NEAR AI"},
    openrouter: {Glyph: OpenRouterIcon, tile: "#7C5CF6", label: "OpenRouter"},
    ollama: {Glyph: OllamaIcon, tile: NEUTRAL_TILE, label: "Ollama"},
};

export function providerBrand(id: string): ProviderBrand {
    return PROVIDER_BRANDS[id] ?? {tile: NEUTRAL_TILE};
}
