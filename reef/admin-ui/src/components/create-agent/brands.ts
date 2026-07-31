/** Provider id -> brand glyph + tile washes (the OptionCard language). Washes
 *  use each brand's current palette: Anthropic clay #D97757; OpenAI has been
 *  officially monochrome since its 2025 rebrand, so its tile carries the
 *  signature product green #10A37F; Gemini brand blue #4285F4; Ollama is
 *  monochrome (neutral wash). Unknown ids (a future registry entry) get the
 *  neutral wash + no glyph - the tile still renders. */
import type React from "react"
import {
  AnthropicIcon,
  CodexColorIcon,
  GeminiIcon,
  NearAiIcon,
  OllamaIcon,
  OpenAiIcon,
} from "@/components/agent-icons"

export interface ProviderBrand {
  Glyph: React.ComponentType<{ className?: string }> | null
  /** CSS background for the icon's app-tile (the OptionCard language). */
  tile: string
  /** One-line descriptor under the provider name. */
  line: string
}

const NEUTRAL_TILE = "linear-gradient(180deg, #404040, #171717)"

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
  // ChatGPT-subscription (Codex OAuth): the operator signs in with their
  // ChatGPT plan inside the VM after launch. The Codex mark on a white tile
  // (its own app-icon look) sets it apart from the monochrome OpenAI tile.
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
  ollama: {
    Glyph: OllamaIcon,
    tile: NEUTRAL_TILE,
    line: "Local, on your own server",
  },
}

export function providerBrand(id: string): ProviderBrand {
  return PROVIDER_BRANDS[id] ?? { Glyph: null, tile: NEUTRAL_TILE, line: "" }
}

/** Chip tints for the summary rail (brand foreground colours; ollama and
 *  nearai stay monochrome by design, utility glyphs stay neutral). */
export const PROVIDER_TINTS: Record<string, string> = {
  anthropic: "text-[#D97757]",
  openai: "text-[#10A37F]",
  gemini: "text-[#4285F4]",
}
