/** Provider id to brand glyph and one flat tile color: the brand's own hue, or
 *  its product color where the brand is monochrome (OpenAI green, Ollama
 *  neutral). Unknown ids get the neutral tile and no glyph. Declaration order is
 *  the model picker's vendor order. */
import type {ComponentType} from "react";
import {
    AionLabsIcon,
    AnthropicIcon,
    ArceeIcon,
    ByteDanceIcon,
    CodexColorIcon,
    CohereIcon,
    DeepSeekIcon,
    GeminiIcon,
    HunyuanIcon,
    IbmIcon,
    InceptionIcon,
    KimiIcon,
    KwaipilotIcon,
    LiquidIcon,
    LmStudioIcon,
    LongCatIcon,
    MetaIcon,
    MicrosoftIcon,
    MinimaxIcon,
    MistralIcon,
    NearAiIcon,
    NousIcon,
    NovaIcon,
    NvidiaIcon,
    OllamaIcon,
    OpenAiIcon,
    OpenRouterIcon,
    PerplexityIcon,
    QwenIcon,
    StepFunIcon,
    UpstageIcon,
    WenxinIcon,
    XaiIcon,
    XiaomiIcon,
    ZaiIcon,
} from "@/components/ProviderIcons";

interface ProviderBrand {
    Glyph?: ComponentType<{className?: string}>;
    tile: string;
    label?: string;
}

const NEUTRAL_TILE = "#262626";
const GEMINI: ProviderBrand = {Glyph: GeminiIcon, tile: "#4285F4", label: "Google"};
const vendor = (Glyph: ProviderBrand["Glyph"], label: string): ProviderBrand => ({Glyph, tile: NEUTRAL_TILE, label});

const PROVIDER_BRANDS: Record<string, ProviderBrand> = {
    anthropic: {Glyph: AnthropicIcon, tile: "#D97757", label: "Anthropic"},
    openai: {Glyph: OpenAiIcon, tile: "#10A37F", label: "OpenAI"},
    "openai-codex": {Glyph: CodexColorIcon, tile: "#ffffff", label: "Codex"},
    google: GEMINI,
    gemini: GEMINI,
    deepseek: vendor(DeepSeekIcon, "DeepSeek"),
    "x-ai": vendor(XaiIcon, "xAI"),
    moonshotai: vendor(KimiIcon, "Moonshot"),
    qwen: vendor(QwenIcon, "Qwen"),
    "z-ai": vendor(ZaiIcon, "Z.ai"),
    "meta-llama": vendor(MetaIcon, "Meta"),
    meta: vendor(MetaIcon, "Meta"),
    mistralai: vendor(MistralIcon, "Mistral"),
    minimax: vendor(MinimaxIcon, "MiniMax"),
    cohere: vendor(CohereIcon, "Cohere"),
    nvidia: vendor(NvidiaIcon, "NVIDIA"),
    microsoft: vendor(MicrosoftIcon, "Microsoft"),
    amazon: vendor(NovaIcon, "Amazon"),
    perplexity: vendor(PerplexityIcon, "Perplexity"),
    "bytedance-seed": vendor(ByteDanceIcon, "ByteDance"),
    bytedance: vendor(ByteDanceIcon, "ByteDance"),
    tencent: vendor(HunyuanIcon, "Tencent"),
    baidu: vendor(WenxinIcon, "Baidu"),
    xiaomi: vendor(XiaomiIcon, "Xiaomi"),
    meituan: vendor(LongCatIcon, "Meituan"),
    stepfun: vendor(StepFunIcon, "StepFun"),
    "ibm-granite": vendor(IbmIcon, "IBM"),
    nousresearch: vendor(NousIcon, "Nous Research"),
    inception: vendor(InceptionIcon, "Inception"),
    liquid: vendor(LiquidIcon, "Liquid"),
    "arcee-ai": vendor(ArceeIcon, "Arcee AI"),
    upstage: vendor(UpstageIcon, "Upstage"),
    "aion-labs": vendor(AionLabsIcon, "Aion Labs"),
    kwaipilot: vendor(KwaipilotIcon, "Kwaipilot"),
    nearai: {Glyph: NearAiIcon, tile: "#000000", label: "NEAR AI"},
    openrouter: {Glyph: OpenRouterIcon, tile: "#7C5CF6", label: "OpenRouter"},
    ollama: {Glyph: OllamaIcon, tile: NEUTRAL_TILE, label: "Ollama"},
    lmstudio: vendor(LmStudioIcon, "LM Studio"),
};

const BRAND_ORDER = Object.keys(PROVIDER_BRANDS);

export function providerBrand(id: string): ProviderBrand {
    return PROVIDER_BRANDS[id] ?? {tile: NEUTRAL_TILE};
}

export function brandRank(id: string): number {
    const rank = BRAND_ORDER.indexOf(id);
    return rank < 0 ? BRAND_ORDER.length : rank;
}
