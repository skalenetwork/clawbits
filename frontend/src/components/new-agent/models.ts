/** Curated per-provider model lists for the wizard's model select (LOCKED:
 *  these ship as static frontend data — trivially updatable, no reef coupling).
 *  Ids are BARE (no provider/ prefix): the reef rides them to the guest as
 *  REEF_DEFAULT_MODEL and each runtime's entrypoint qualifies/strips as its
 *  own config needs. Free text stays available for anything not listed.
 *
 *  intelligence / speed / cost are RELATIVE 1-3 guides WITHIN a provider's own
 *  lineup — a chooser aid, not cross-provider benchmarks. More filled = smarter,
 *  faster, or pricier. Local (ollama) models omit them: speed and cost depend on
 *  the operator's own hardware, so they carry a "Local" chip instead. */

export type ModelTier = "frontier" | "balanced" | "fast" | "local";

export interface CuratedModel {
    id: string;
    label: string;
    /** One-line, plain-English descriptor. */
    blurb?: string;
    /** Where it sits on the capable <-> fast/cheap spectrum (drives the chip). */
    tier?: ModelTier;
    intelligence?: 1 | 2 | 3;
    speed?: 1 | 2 | 3;
    cost?: 1 | 2 | 3;
}

export interface TierMeta {
    label: string;
    /** Chip classes — a subtle tinted pill, the status-badge language. */
    chip: string;
}

export const TIER_META: Record<ModelTier, TierMeta> = {
    frontier: {label: "Most capable", chip: "bg-violet-500/15 text-violet-600 dark:text-violet-400"},
    balanced: {label: "Balanced", chip: "bg-blue-500/15 text-blue-600 dark:text-blue-400"},
    fast: {label: "Fast & light", chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"},
    local: {label: "Local", chip: "bg-muted text-muted-foreground"},
};

export const CURATED_MODELS: Record<string, CuratedModel[]> = {
    anthropic: [
        {
            id: "claude-opus-4-8",
            label: "Claude Opus 4.8",
            tier: "frontier",
            blurb: "Deepest reasoning for the hardest problems",
            intelligence: 3,
            speed: 1,
            cost: 3,
        },
        {
            id: "claude-sonnet-4-6",
            label: "Claude Sonnet 4.6",
            tier: "balanced",
            blurb: "Smart and quick for everyday work",
            intelligence: 2,
            speed: 2,
            cost: 2,
        },
        {
            id: "claude-haiku-4-5",
            label: "Claude Haiku 4.5",
            tier: "fast",
            blurb: "Snappy and economical for lighter work",
            intelligence: 1,
            speed: 3,
            cost: 1,
        },
    ],
    openai: [
        // gpt-5.5 omitted: the pinned OpenClaw codex runtime crashes its
        // session-mirror hook on gpt-5.5, breaking every message after the
        // first (session-init conflict). The curated lists are shared across
        // runtimes, so Hermes sits it out too until the OpenClaw image catches
        // up (or the lists go per-runtime).
        {
            id: "gpt-5.4",
            label: "GPT-5.4",
            tier: "frontier",
            blurb: "Top-tier reasoning and coding",
            intelligence: 3,
            speed: 2,
            cost: 3,
        },
        {
            id: "gpt-5.4-mini",
            label: "GPT-5.4 mini",
            tier: "fast",
            blurb: "Faster and cheaper for everyday tasks",
            intelligence: 2,
            speed: 3,
            cost: 1,
        },
    ],
    gemini: [
        {
            id: "gemini-3.1-pro-preview",
            label: "Gemini 3.1 Pro",
            tier: "frontier",
            blurb: "Deepest reasoning & agentic coding (preview)",
            intelligence: 3,
            speed: 1,
            cost: 3,
        },
        {
            id: "gemini-3.5-flash",
            label: "Gemini 3.5 Flash",
            tier: "balanced",
            blurb: "Flagship-class smarts at flash speed",
            intelligence: 2,
            speed: 2,
            cost: 2,
        },
        {
            id: "gemini-3.1-flash-lite",
            label: "Gemini 3.1 Flash Lite",
            tier: "fast",
            blurb: "Fastest and most cost-efficient, built for volume",
            intelligence: 1,
            speed: 3,
            cost: 1,
        },
    ],
    // NEAR Cloud AI hosts open models under HF-style org/model ids — the id IS
    // the full path (no provider prefix; the runtime entrypoints qualify/strip
    // as their config needs). Free text stays available for the rest of NEAR's
    // catalog.
    nearai: [
        {
            id: "zai-org/GLM-5.1-FP8",
            label: "GLM 5.1",
            tier: "frontier",
            blurb: "Z.ai's frontier open model",
            intelligence: 3,
            speed: 2,
            cost: 2,
        },
        {
            id: "deepseek-ai/DeepSeek-V4-Flash",
            label: "DeepSeek V4 Flash",
            tier: "fast",
            blurb: "Fast open model for everyday tasks",
            intelligence: 2,
            speed: 3,
            cost: 1,
        },
    ],
    // OpenRouter ids are vendor/model slugs — like nearai, the id IS the full
    // path (no openrouter/ prefix; the runtime entrypoints qualify/strip as
    // their config needs). The curated picks are FREE (:free) catalog models
    // on purpose — a fresh BYO-key agent shouldn't surprise-spend — and the
    // same slug is the entrypoints' no-pick default. The full (mostly paid)
    // catalog stays a search away in the field below the pills.
    openrouter: [
        // Deliberately bare rows — name + the "Free" chip (derived from the
        // :free id suffix; no `cost`, or the coins meter would read "cheap"
        // instead). No tier and no meters: those describe a provider's OWN
        // lineup, and on a whole-catalog aggregator they'd be editorializing;
        // bare also matches the pills the live-catalog validation substitutes in.
        {
            id: "nvidia/nemotron-3-ultra-550b-a55b:free",
            label: "Nemotron 3 Ultra",
            blurb: "NVIDIA's largest open model",
        },
        // Also the entrypoints' no-pick default. Verified live on 2026-09-03;
        // the previous `nemotron-nano-9b-v2:free` had been withdrawn from
        // OpenRouter and 404'd for every agent that took the default. Free-tier
        // slugs rotate — check https://openrouter.ai/api/v1/models before
        // editing, and keep this in step with the runtime entrypoints.
        {
            id: "nvidia/nemotron-3.5-lightning:free",
            label: "Nemotron 3.5 Lightning",
            blurb: "NVIDIA's efficient open model, tuned for agents",
        },
    ],
    // Ollama models are whatever the user's server has pulled — suggestions
    // only; the field itself is free text and REQUIRED (no sane default). Local,
    // so speed/cost ride on the host's hardware — no meters, just a "Local" chip.
    ollama: [
        {id: "llama3.2", label: "Llama 3.2", tier: "local", blurb: "Meta's compact open model"},
        {id: "qwen3.5", label: "Qwen 3.5", tier: "local", blurb: "Strong multilingual open model"},
        {id: "gemma4", label: "Gemma 4", tier: "local", blurb: "Google's efficient open model"},
    ],
};
