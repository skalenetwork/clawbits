/**
 * Step 1 - which runtime. Big cards (OpenClaw / IronClaw / Hermes) in the
 * wizard's OptionCard language. Clicking a card IS the decision and advances. An
 * image-version select sits at the selected card's foot (reef is the
 * image-management tool - operators may want a specific/newly-built image);
 * default = the type's active image. A type with no image built yet is disabled
 * with the build hint.
 */
import { AGENT_TYPE_LIST } from "@/lib/agentTypes"
import type { ImageInfo } from "@/lib/api"
import { OptionCard } from "./bits"

/** Short one-liners for the picker cards (the agentTypes blurbs are longer). */
const SHORT_LINE: Record<string, string> = {
  openclaw: "Gateway + Control UI",
  ironclaw: "Rust agent + gateway",
  hermes: "Gateway + dashboard",
}

export function TypeStep({
  runtime,
  onPick,
  images,
  imageTag,
  onImageTag,
}: {
  runtime: string | null
  onPick: (name: string) => void
  /** All images the Reef advertises; null = still loading. */
  images: ImageInfo[] | null
  imageTag: string | null
  onImageTag: (tag: string | null) => void
}) {
  return (
    <div className="grid grid-cols-1 content-start gap-3 sm:grid-cols-2">
      {AGENT_TYPE_LIST.map((t) => {
        const typeImages = images?.filter((i) => i.agent_type === t.name) ?? null
        // A known-empty image list for an otherwise-buildable type ⇒ nothing to boot.
        const noImage = t.enabled && typeImages !== null && typeImages.length === 0
        const selected = runtime === t.name
        const activeTag = typeImages?.find((i) => i.is_active)?.tag ?? typeImages?.[0]?.tag ?? null
        return (
          <OptionCard
            key={t.name}
            icon={<t.Icon className="size-11" />}
            title={t.label}
            line={
              !t.enabled ? "Coming soon" : noImage ? "No image built yet" : SHORT_LINE[t.name] ?? ""
            }
            selected={selected}
            disabled={!t.enabled || noImage}
            onSelect={() => {
              onPick(t.name)
            }}
          >
            {selected && typeImages !== null && typeImages.length > 0 && (
              <select
                value={imageTag ?? activeTag ?? ""}
                onChange={(e) => {
                  // Choosing the active default clears the pin.
                  onImageTag(e.target.value === activeTag ? null : e.target.value)
                }}
                onClick={(e) => {
                  e.stopPropagation()
                }}
                className="animate-in self-start rounded-lg border border-border/60 bg-background/40 px-3 py-1.5 text-[13px] fade-in duration-200"
                aria-label="Image version"
              >
                {typeImages.map((img) => (
                  <option key={img.tag} value={img.tag}>
                    {img.tag}
                    {img.reef_image_version ? ` · v${img.reef_image_version}` : ""}
                    {img.is_active ? " · active" : ""}
                  </option>
                ))}
              </select>
            )}
          </OptionCard>
        )
      })}
    </div>
  )
}
