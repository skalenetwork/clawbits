/**
 * Step 3 - Options: everything the provider pick still needs, plus the optional
 * extras. When the Reef already has the provider CONFIGURED, the key/host + model
 * collapse into a one-line compact row (the defaults just work) that expands only
 * if the operator wants to override. An unconfigured provider shows the full
 * (required) fields. Live Ollama model discovery is deferred - the model field is
 * free text with suggestions. "Continue" just advances to Connect - the actual
 * create fires there (Connect is now the last configurable step).
 */
import { useState } from "react"
import {
  ArrowDown01Icon,
  Brain01Icon,
  Coins01Icon,
  Comment02Icon,
  FlashIcon,
  KeyIcon,
  Link01Icon,
  SourceCodeIcon,
  SparklesIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Icon } from "@/components/Icon"
import { cn } from "@/lib/utils"
import type { ProviderInfo } from "@/lib/api"
import { useOpenRouterModels } from "@/lib/queries"
import { providerBrand } from "./brands"
import { CURATED_MODELS, TIER_META, type CuratedModel } from "./models"
import { AddEnvRowButton, EnvVarRow, ENV_KEY_RE } from "./bits"
import type { WizardState } from "./useCreateWizard"

/** The AI-model section's tile wash (shared by the compact row + full section). */
const MODEL_TILE = "linear-gradient(180deg, #f778387d, #1cb8d985)"

/** Opt-in capabilities, mirroring reef/capabilities.py. Keep the ids in sync -
 *  the API rejects an unknown one with a 422 rather than dropping it. */
const CAPABILITY_OPTIONS: { id: string; label: string; blurb: string }[] = [
  {
    id: "gh",
    label: "GitHub CLI",
    blurb:
      "Puts `gh` on the agent's PATH. Inert until you give it a token - reef supplies none.",
  },
  {
    id: "cron",
    label: "Scheduling",
    blurb:
      "Lets the agent schedule its own recurring work. Persists beyond a conversation.",
  },
]

/** The "let the runtime decide" option - a plain row, no tier or meters. */
const RUNTIME_DEFAULT: CuratedModel = {
  id: "",
  label: "Runtime default",
  blurb: "Use the runtime's recommended model",
}

export function OptionsStep({
  state,
  providers,
  onByo,
  onModel,
  onEnvRows,
  onContinue,
  continueEnabled,
  pending,
  supportsCapabilities,
  onToggleCapability,
}: {
  state: WizardState
  providers: ProviderInfo[] | null
  onByo: (id: string, value: string) => void
  onModel: (model: string) => void
  onEnvRows: (rows: { key: string; value: string }[]) => void
  onContinue: () => void
  continueEnabled: boolean
  pending: boolean
  /** This reef advertises the create-API `capabilities` field. Older reefs drop
   *  unknown fields silently, so the section is hidden rather than lying. */
  supportsCapabilities: boolean
  onToggleCapability: (id: string) => void
}) {
  const picked = providers?.find((p) => p.id === state.providerId) ?? null
  const brand = picked ? providerBrand(picked.id) : null
  const isEndpoint = (picked?.kind ?? "api_key") === "endpoint"
  // OAuth/subscription (ChatGPT plan): no key or model to configure here - the
  // operator signs in inside the agent's terminal after launch (the Launch
  // step's connect card).
  const isOauth = (picked?.kind ?? "") === "oauth"
  const configured = picked?.configured ?? false
  const showKey = Boolean(picked && picked.id !== "none" && !isEndpoint && !isOauth)
  const showHost = Boolean(picked && isEndpoint)
  const showModel = Boolean(picked) && picked?.id !== "none" && !isOauth
  const curated = picked && picked.id !== "none" ? (CURATED_MODELS[picked.id] ?? []) : []

  // Configured ⇒ collapse the key/host + model behind a compact row; expand only
  // to override. Model collapses only when it has a default (api_key providers -
  // ollama's model is required with no default, so it stays open).
  const [keyOpen, setKeyOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const keyCollapsed = configured && !keyOpen
  const modelCollapsed = configured && !isEndpoint && !modelOpen
  // OpenRouter: feed the free-text model field a datalist of the live catalog
  // (reef-proxied; see useOpenRouterModels). Any failure just means no
  // suggestions — the field itself already accepts any vendor/model slug.
  const isOpenRouter = picked?.id === "openrouter"
  const orCatalog = useOpenRouterModels(isOpenRouter)
  const orModels = orCatalog.data?.models ?? []

  // Pills validated against that catalog: hand-curated slugs are written blind
  // and CAN drift from what openrouter.ai actually serves (a phantom pill pins
  // a model the agent then refuses to run). Once the catalog is loaded, drop
  // any pill it doesn't confirm and top back up to two with real :free entries
  // — free-by-default, provably available. An unloaded/failed catalog keeps
  // the static picks (benefit of the doubt).
  const pills = (() => {
    if (!isOpenRouter || orModels.length === 0) return curated
    const ids = new Set(orModels.map((m) => m.id))
    const confirmed = curated.filter((m) => ids.has(m.id))
    const derived = orModels
      .filter((m) => m.id.endsWith(":free") && !confirmed.some((c) => c.id === m.id))
      .slice(0, Math.max(0, 2 - confirmed.length))
      .map((m): CuratedModel => ({ id: m.id, label: m.name ?? m.id, blurb: "Free on OpenRouter" }))
    return [...confirmed, ...derived]
  })()

  const modelLabel =
    state.model.trim() === ""
      ? "Runtime default"
      : (pills.find((m) => m.id === state.model)?.label ?? state.model)

  const envKeys = state.envRows.map((r) => r.key.trim()).filter((k) => k.length > 0)
  const envInvalid =
    envKeys.some((k) => !ENV_KEY_RE.test(k)) || new Set(envKeys).size !== envKeys.length

  const nothingToConfigure = !picked || picked.id === "none"

  return (
    <div className="flex flex-col gap-3">
      {isOauth && brand?.Glyph && (
        <div className="rounded-2xl border border-border/50 bg-foreground/[0.02] p-4">
          <div className="flex items-center gap-3">
            <span
              className="flex size-10 shrink-0 items-center justify-center rounded-xl text-white ring-1 ring-white/10 [&_svg]:size-5 [&_img]:size-6"
              style={{ background: brand.tile }}
            >
              <brand.Glyph />
            </span>
            <span className="min-w-0 flex-1 truncate text-base font-semibold">
              {picked?.label ?? "ChatGPT subscription"}
            </span>
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
              No key needed
            </span>
          </div>
          <p className="px-1 pt-3 text-[13px] leading-relaxed text-muted-foreground">
            After launch, sign in with your ChatGPT account in the agent's terminal - one command,
            then approve in your browser. Your plan powers the agent, and your login never leaves it.
          </p>
        </div>
      )}

      {picked &&
        showKey &&
        brand?.Glyph &&
        (keyCollapsed ? (
          <CompactRow
            tile={brand.tile}
            icon={<brand.Glyph />}
            title={`${picked.label} key`}
            summary="Using this Reef's key"
            action="Override"
            disabled={pending}
            onClick={() => {
              setKeyOpen(true)
            }}
          />
        ) : (
          <Section
            tile={brand.tile}
            icon={<brand.Glyph />}
            title={`${picked.label} API key`}
            required={!configured}
          >
            <BigInput
              icon={KeyIcon}
              type="password"
              value={state.byoValues[picked.id] ?? ""}
              onChange={(v) => {
                onByo(picked.id, v)
              }}
              placeholder={configured ? "Your own key" : `Paste your ${picked.label} API key`}
              disabled={pending}
            />
            <p className="flex items-center gap-1.5 px-1 pt-2 text-xs text-muted-foreground">
              <Icon icon={KeyIcon} className="size-3 shrink-0" />
              {configured ? "Leave blank to use this Reef's key." : "Sent to this Reef only, never stored."}
            </p>
          </Section>
        ))}

      {picked &&
        showHost &&
        brand?.Glyph &&
        (keyCollapsed ? (
          <CompactRow
            tile={brand.tile}
            icon={<brand.Glyph />}
            title="Ollama server"
            summary="Using this Reef's host"
            action="Override"
            disabled={pending}
            onClick={() => {
              setKeyOpen(true)
            }}
          />
        ) : (
          <Section
            tile={brand.tile}
            icon={<brand.Glyph />}
            title="Ollama server"
            required={!configured}
          >
            <BigInput
              icon={Link01Icon}
              type="text"
              value={state.byoValues[picked.id] ?? ""}
              onChange={(v) => {
                onByo(picked.id, v)
              }}
              placeholder={configured ? "Your own host URL" : "http://host.docker.internal:11434"}
              disabled={pending}
            />
            {configured && (
              <p className="flex items-center gap-1.5 px-1 pt-2 text-xs text-muted-foreground">
                <Icon icon={Link01Icon} className="size-3 shrink-0" />
                Leave blank to use this Reef's host.
              </p>
            )}
          </Section>
        ))}

      {showModel &&
        (modelCollapsed ? (
          <CompactRow
            tile={MODEL_TILE}
            icon={<Icon icon={SparklesIcon} />}
            title="Model"
            summary={modelLabel}
            action="Change"
            disabled={pending}
            onClick={() => {
              setModelOpen(true)
            }}
          />
        ) : (
          <Section
            tile={MODEL_TILE}
            icon={<Icon icon={SparklesIcon} />}
            title="Model"
            required={isEndpoint}
          >
            <div className="flex flex-col gap-2.5">
              <BigInput
                icon={SparklesIcon}
                type="text"
                value={state.model}
                onChange={onModel}
                placeholder={
                  isEndpoint
                    ? "Model (required) - e.g. llama3.2"
                    : isOpenRouter
                      ? "Runtime default - type to search the catalog"
                      : "Runtime default"
                }
                disabled={pending}
                list={isOpenRouter ? "openrouter-catalog" : undefined}
              />
              {isOpenRouter && (
                <>
                  <datalist id="openrouter-catalog">
                    {orModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name ?? m.id}
                      </option>
                    ))}
                  </datalist>
                  <p className="px-1 text-xs text-muted-foreground">
                    {orCatalog.isFetching
                      ? "Loading the catalog from openrouter.ai…"
                      : orModels.length > 0
                        ? `${String(orModels.length)} models, live from openrouter.ai - or type any vendor/model slug.`
                        : "Couldn't load the catalog - type a vendor/model slug (e.g. openai/gpt-5.4)."}
                  </p>
                </>
              )}
              <div className="flex flex-col gap-2">
                {!isEndpoint && (
                  <ModelOption
                    model={RUNTIME_DEFAULT}
                    selected={state.model.trim() === ""}
                    disabled={pending}
                    onClick={() => {
                      onModel("")
                    }}
                  />
                )}
                {pills.map((m) => (
                  <ModelOption
                    key={m.id}
                    model={m}
                    selected={state.model === m.id}
                    disabled={pending}
                    onClick={() => {
                      onModel(m.id)
                    }}
                  />
                ))}
              </div>
            </div>
          </Section>
        ))}

      {supportsCapabilities && (
        <Section
          tile="linear-gradient(180deg, #f59e0b7d, #b4530985)"
          icon={<Icon icon={SourceCodeIcon} />}
          title="Capabilities"
        >
          <div className="flex flex-col gap-2.5">
            <p className="px-1 text-xs text-muted-foreground">
              Off by default. These reach outside the agent's VM - everything
              inside it (shell, packages, browser) is always available.
            </p>
            {CAPABILITY_OPTIONS.map((cap) => (
              <CapabilityRow
                key={cap.id}
                cap={cap}
                checked={state.capabilities.includes(cap.id)}
                disabled={pending}
                onToggle={() => {
                  onToggleCapability(cap.id)
                }}
              />
            ))}
          </div>
        </Section>
      )}

      <Section
        tile="linear-gradient(180deg, #10b9817d, #0e749085)"
        icon={<Icon icon={SourceCodeIcon} />}
        title="Environment variables"
      >
        <div className="flex flex-col gap-2.5">
          {state.envRows.map((row, i) => (
            <EnvVarRow
              key={i}
              row={row}
              disabled={pending}
              onChange={(next) => {
                onEnvRows(state.envRows.map((r, j) => (j === i ? next : r)))
              }}
              onRemove={() => {
                onEnvRows(state.envRows.filter((_, j) => j !== i))
              }}
            />
          ))}
          {envInvalid && (
            <p className="px-1 text-xs text-destructive">
              Names: letters, digits and "_", no leading digit, no duplicates.
            </p>
          )}
          <AddEnvRowButton
            disabled={pending}
            onClick={() => {
              onEnvRows([...state.envRows, { key: "", value: "" }])
            }}
          />
        </div>
      </Section>

      {nothingToConfigure && (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-border/50 bg-foreground/[0.02] px-4 py-6 text-center">
          <Icon icon={Comment02Icon} className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No model wired - you can pick one later in the Control UI.
          </p>
        </div>
      )}

      <Button
        onClick={onContinue}
        disabled={!continueEnabled || envInvalid || pending}
        size="lg"
        className="mt-1 h-12 w-full text-base"
      >
        Continue
      </Button>
    </div>
  )
}

/** The collapsed one-liner for an already-configured provider: tile + title +
 *  the default it'll use, with an expand affordance to override. */
function CompactRow({
  tile,
  icon,
  title,
  summary,
  action,
  onClick,
  disabled,
}: {
  tile: string
  icon: React.ReactNode
  title: string
  summary: string
  action: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-3 rounded-2xl border border-border/50 bg-foreground/[0.02] px-4 py-3 text-left transition-colors hover:bg-foreground/[0.04] disabled:opacity-50"
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-xl text-white ring-1 ring-white/10 [&_svg]:size-[18px]"
        style={{ background: tile }}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold">{title}</span>
        <span className="truncate text-xs text-muted-foreground">{summary}</span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 text-xs font-medium text-muted-foreground">
        {action}
        <Icon icon={ArrowDown01Icon} className="size-3.5" />
      </span>
    </button>
  )
}

/** One icon-tiled section - the Options step's card language. */
function Section({
  tile,
  icon,
  title,
  required,
  children,
}: {
  tile: string
  icon: React.ReactNode
  title: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-foreground/[0.02]">
      <div className="flex items-center gap-3 px-4 pt-4">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-xl text-white ring-1 ring-white/10 [&_svg]:size-5"
          style={{ background: tile }}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-base font-semibold">{title}</span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
            required ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground",
          )}
        >
          {required ? "Required" : "Optional"}
        </span>
      </div>
      <div className="px-4 pt-3.5 pb-4">{children}</div>
    </div>
  )
}

/** One selectable model row: a big name + a tier chip, over icon meters
 *  (brain = intelligence, bolt = speed, coins = cost) so the trade-off - smarter
 *  & heavier vs cheaper & faster - reads at a glance without wordy labels. The
 *  one-line descriptor rides along as the hover title. Selection = ring + tinted
 *  bg + a corner check, matching the wizard's OptionCard language. */
function ModelOption({
  model,
  selected,
  disabled,
  onClick,
}: {
  model: CuratedModel
  selected: boolean
  disabled: boolean
  onClick: () => void
}) {
  const tier = model.tier ? TIER_META[model.tier] : null
  // :free catalog variants (OpenRouter) cost nothing — say so with a chip in
  // the cost accent colour (amber) and DROP the coins meter: a 1-of-3 cost
  // meter reads "cheap", which undersells free. Derived from the id, so
  // catalog-substituted pills get the chip too.
  const isFree = model.id.endsWith(":free")
  const hasMeters =
    model.intelligence != null || model.speed != null || model.cost != null
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      title={model.blurb}
      className={cn(
        "relative flex w-full flex-col gap-3 rounded-xl border p-4 text-left transition duration-150 active:scale-[0.99] disabled:opacity-50",
        selected
          ? "border-foreground/40 bg-foreground/[0.06] ring-1 ring-inset ring-foreground/15"
          : "border-border/50 bg-foreground/[0.02] hover:border-foreground/25 hover:bg-foreground/[0.04]",
      )}
    >
      {selected && (
        <span className="absolute top-3.5 right-3.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background">
          <Icon icon={Tick01Icon} className="size-3" />
        </span>
      )}
      <div className="flex items-center gap-2.5 pr-8">
        <span className="text-base font-semibold leading-none">{model.label}</span>
        {tier && (
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
              tier.chip,
            )}
          >
            {tier.label}
          </span>
        )}
        {isFree && (
          <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
            Free
          </span>
        )}
      </div>
      {hasMeters && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <StatMeter icon={Brain01Icon} label="Intelligence" level={model.intelligence ?? 0} />
          <StatMeter icon={FlashIcon} label="Speed" level={model.speed ?? 0} />
          {!isFree && <StatMeter icon={Coins01Icon} label="Cost" level={model.cost ?? 0} cost />}
        </div>
      )}
    </button>
  )
}

/** An icon + a 3-segment meter - the relative 1-3 guide, label-free (the icon
 *  IS the label; the full word rides in title/aria for a11y). Cost fills amber,
 *  the one functional colour accent. */
function StatMeter({
  icon,
  label,
  level,
  cost,
}: {
  icon: React.ComponentProps<typeof Icon>["icon"]
  label: string
  level: number
  cost?: boolean
}) {
  return (
    <span
      className="flex items-center gap-1.5"
      title={label}
      aria-label={`${label}: ${String(level)} of 3`}
    >
      <Icon icon={icon} className="size-4 text-muted-foreground" />
      <span className="flex gap-0.5">
        {[1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn(
              "h-2 w-4 rounded-full",
              i <= level
                ? cost
                  ? "bg-amber-500 dark:bg-amber-400"
                  : "bg-foreground/75"
                : "bg-foreground/[0.12]",
            )}
          />
        ))}
      </span>
    </span>
  )
}

function BigInput({
  icon,
  value,
  onChange,
  ...props
}: {
  icon: React.ComponentProps<typeof Icon>["icon"]
  value: string
  onChange: (v: string) => void
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange">) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted-foreground">
        <Icon icon={icon} className="size-[18px]" />
      </span>
      <Input
        className="h-12 rounded-xl pl-11 text-base"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
        }}
        {...props}
      />
    </div>
  )
}

/** One capability toggle. Deliberately plain: a checkbox and an honest sentence,
 *  not a persuasive card - every row here widens what the agent can touch
 *  outside its VM, so the copy should read as a caution, not a feature pitch. */
function CapabilityRow({
  cap,
  checked,
  disabled,
  onToggle,
}: {
  cap: { id: string; label: string; blurb: string }
  checked: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <label
      className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border/50 px-3 py-2.5 transition-colors hover:bg-foreground/[0.02]"
      data-testid={`capability-${cap.id}`}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-foreground"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm">{cap.label}</span>
        <span className="text-xs text-muted-foreground">{cap.blurb}</span>
      </span>
    </label>
  )
}
