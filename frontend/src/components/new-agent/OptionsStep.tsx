/**
 * Step 4 — Options (reef path only): everything the provider pick still needs,
 * plus the optional extras, as FLAT collapsible sections (no nested cards —
 * hairline dividers carry the structure; every header toggles open/closed and
 * shows the section's current value while closed):
 *   • API key      — when the picked keyed provider isn't reef-configured
 *   • Ollama       — host (when not reef-configured) + REQUIRED model, offered
 *     as the server's own pulled-model dropdown (reef-side probe) with a
 *     free-text escape hatch
 *   • Model        — selectable pills of curated models (keyed providers,
 *     when the Reef accepts a create-time model)
 *   • Env vars     — custom guest env (when the Reef accepts them)
 * The big CTA is the wizard's explicit "Create agent" commit.
 */
import {useState} from "react";
import {
    KeyIcon as Key,
    SourceCodeIcon as SourceCode,
    SparklesIcon as Sparkles,
    CpuIcon as Cpu,
    Link01Icon as LinkIcon,
    Comment02Icon as SkipGlyph,
    ArrowDown01Icon as ArrowDown,
    Tick01Icon as Tick,
    Brain01Icon as Brain,
    FlashIcon as Flash,
    Coins01Icon as Coins,
    Alert02Icon as Alert,
} from "@hugeicons/core-free-icons";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Icon} from "@/components/Icon";
import {cn} from "@/lib/utils";
import type {ReefOllamaModel, ReefProvider} from "@/lib/reefApi";
import {providerBrand} from "./brands";
import {CURATED_MODELS, TIER_META, type CuratedModel} from "./models";
import {AddEnvRowButton, EnvVarRow} from "./bits";
import {ENV_KEY_RE} from "./prompts";

// Known API-key prefixes, per provider id. Warn-only sanity check on the BYO
// field: it catches the classic paste trap — the clipboard still holding some
// other generated token (an agent's access password, a signup token) — before
// the key is baked immutably into the VM's env, where the only fix is a
// recreate. Formats drift, so a mismatch never blocks the create.
const KEY_PREFIXES: Record<string, string> = {
    openai: "sk-",
    anthropic: "sk-ant-",
    gemini: "AIza",
};

function keyFormatWarning(providerId: string, value: string, label: string): string | null {
    const v = value.trim();
    const prefix = KEY_PREFIXES[providerId];
    if (!v || !prefix || v.startsWith(prefix)) return null;
    return `This doesn't look like a ${label} API key (expected to start with "${prefix}"). If you copied an agent's access password or another token, paste your provider key instead.`;
}
import type {WizardState} from "./useWizard";

export interface OllamaProbe {
    models: ReefOllamaModel[] | null; // null = not probed / failed
    loading: boolean;
    error: boolean;
}

function gb(bytes: number | null | undefined): string | null {
    if (!bytes) return null;
    return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** The "let the runtime decide" option — a plain row, no tier or meters. */
const RUNTIME_DEFAULT: CuratedModel = {
    id: "",
    label: "Runtime default",
    blurb: "Use the runtime's recommended model",
};

export function OptionsStep({
    state,
    providers,
    modelSupported,
    envSupported,
    ollamaProbe,
    onByo,
    onModel,
    onEnvRows,
    onCreate,
    createEnabled,
    pending,
}: {
    state: WizardState;
    providers: ReefProvider[] | null;
    modelSupported: boolean;
    envSupported: boolean;
    ollamaProbe: OllamaProbe;
    onByo: (id: string, value: string) => void;
    onModel: (model: string) => void;
    onEnvRows: (rows: {key: string; value: string}[]) => void;
    onCreate: () => void;
    createEnabled: boolean;
    pending: boolean;
}) {
    const picked = providers?.find(p => p.id === state.providerId) ?? null;
    const brand = picked ? providerBrand(picked.id) : null;
    const isEndpoint = (picked?.kind ?? "api_key") === "endpoint";
    // OAuth/subscription (ChatGPT plan): no key or model to configure here — the
    // owner signs in inside the agent's terminal after launch (see the Launch
    // step's connect card). Show a short explainer instead of a key field.
    const isOauth = (picked?.kind ?? "") === "oauth";
    // A reef-configured provider still shows its key/host field — as an OPTIONAL
    // override (the Reef lets a per-request value win over its own reef-level one).
    const configured = picked?.configured ?? false;
    const showKey = Boolean(picked) && !isEndpoint && !isOauth;
    const curated = picked && !isEndpoint && !isOauth ? (CURATED_MODELS[picked.id] ?? []) : [];
    const showModelPills =
        Boolean(picked) && !isEndpoint && !isOauth && modelSupported && curated.length > 0;

    // Every section opens AND closes freely. null = the user hasn't touched
    // the toggle, so the smart default stays live while async facts land
    // (providers → configured): required-to-fill sections open, optional ones
    // rest closed behind their value summary.
    const [keyOpen, setKeyOpen] = useState<boolean | null>(null);
    const [modelOpen, setModelOpen] = useState<boolean | null>(null);
    const [envOpen, setEnvOpen] = useState<boolean | null>(null);
    const [ollamaOpen, setOllamaOpen] = useState<boolean | null>(null);
    const [oauthOpen, setOauthOpen] = useState<boolean | null>(null);
    const showKeyOpen = keyOpen ?? !configured;
    const showModelOpen = modelOpen ?? false;
    const showEnvOpen = envOpen ?? state.envRows.length > 0;
    const showOllamaOpen = ollamaOpen ?? true;
    const showOauthOpen = oauthOpen ?? true;
    const modelLabel = state.model.trim() === ""
        ? "Runtime default"
        : (curated.find(m => m.id === state.model)?.label ?? state.model);

    const envKeys = state.envRows.map(r => r.key.trim()).filter(k => k.length > 0);
    const envInvalid =
        envKeys.some(k => !ENV_KEY_RE.test(k)) || new Set(envKeys).size !== envKeys.length;

    // Ollama model dropdown vs free text.
    const [customOllama, setCustomOllama] = useState(false);
    const listed = ollamaProbe.models ?? [];
    const modelInList = listed.some(m => m.id === state.model);
    const showOllamaDropdown = !customOllama && listed.length > 0 && (state.model === "" || modelInList);

    const nothingToConfigure =
        !showKey && !isEndpoint && !showModelPills && !envSupported && !isOauth;

    return (
        <div className="flex flex-col">
            <div className="flex flex-col divide-y divide-border/40">
                {isOauth && brand?.Glyph && (
                    <Section
                        tile={brand.tile}
                        icon={<brand.Glyph/>}
                        title={picked?.label ?? "ChatGPT subscription"}
                        chip={<Chip>No key needed</Chip>}
                        summary="Sign in after launch"
                        open={showOauthOpen}
                        onToggle={() => { setOauthOpen(!showOauthOpen); }}
                    >
                        <p className="text-[13px] leading-relaxed text-muted-foreground">
                            After launch, sign in with your ChatGPT account in the
                            agent's terminal — one command, then approve in your browser.
                            Your plan powers the agent, and your login never leaves it.
                        </p>
                    </Section>
                )}

                {picked && showKey && brand?.Glyph && (
                    <Section
                        tile={brand.tile}
                        icon={<brand.Glyph/>}
                        title={`${picked.label} API key`}
                        chip={configured ? undefined : <Chip tone="required">Required</Chip>}
                        summary={
                            (state.byoValues[picked.id] ?? "").trim() !== ""
                                ? "Key entered"
                                : configured
                                    ? "Using this Reef's key"
                                    : "Not set"
                        }
                        open={showKeyOpen}
                        onToggle={() => { setKeyOpen(!showKeyOpen); }}
                    >
                        <BigInput
                            icon={Key}
                            type="password"
                            value={state.byoValues[picked.id] ?? ""}
                            onChange={(v) => { onByo(picked.id, v); }}
                            placeholder={configured ? "Your own key (optional override)" : `Paste your ${picked.label} API key`}
                            disabled={pending}
                        />
                        {keyFormatWarning(picked.id, state.byoValues[picked.id] ?? "", picked.label) && (
                            <p className="flex items-start gap-1.5 px-1 pt-2 text-xs text-amber-600 dark:text-amber-400">
                                <Icon icon={Alert} className="mt-0.5 size-3 shrink-0"/>
                                {keyFormatWarning(picked.id, state.byoValues[picked.id] ?? "", picked.label)}
                            </p>
                        )}
                        <p className="flex items-center gap-1.5 px-1 pt-2 text-xs text-muted-foreground">
                            <Icon icon={Key} className="size-3 shrink-0"/>
                            {configured
                                ? "Leave blank to use this Reef's key. Goes to your Reef, never to Clawbits."
                                : "Session-only: goes straight to your Reef — never to Clawbits."}
                        </p>
                    </Section>
                )}

                {picked && isEndpoint && brand?.Glyph && (
                    <Section
                        tile={brand.tile}
                        icon={<brand.Glyph/>}
                        title="Ollama server"
                        chip={<Chip tone="required">Required</Chip>}
                        summary={state.model.trim() !== "" ? state.model : "Choose a model"}
                        open={showOllamaOpen}
                        onToggle={() => { setOllamaOpen(!showOllamaOpen); }}
                    >
                        <div className="flex flex-col gap-2.5">
                            <BigInput
                                icon={LinkIcon}
                                type="text"
                                value={state.byoValues[picked.id] ?? ""}
                                onChange={(v) => { onByo(picked.id, v); }}
                                placeholder={
                                    configured
                                        ? "Override the Reef's host (optional)"
                                        : "http://host.docker.internal:11434"
                                }
                                disabled={pending}
                            />
                            {ollamaProbe.loading ? (
                                <p className="flex items-center gap-2 px-1 text-[13px] text-muted-foreground">
                                    <span className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-muted-foreground"/>
                                    Asking the server for its models…
                                </p>
                            ) : showOllamaDropdown ? (
                                <>
                                    <select
                                        value={modelInList ? state.model : ""}
                                        onChange={(e) => {
                                            if (e.target.value === "__custom") {
                                                setCustomOllama(true);
                                                onModel("");
                                            } else {
                                                onModel(e.target.value);
                                            }
                                        }}
                                        disabled={pending}
                                        className="h-12 w-full rounded-xl border border-border/60 bg-background/40 px-3.5 text-base"
                                        aria-label="Ollama model"
                                    >
                                        <option value="" disabled>
                                            Choose a model ({String(listed.length)} on the server)…
                                        </option>
                                        {listed.map((m) => (
                                            <option key={m.id} value={m.id}>
                                                {m.id}
                                                {m.parameter_size ? ` · ${m.parameter_size}` : ""}
                                                {gb(m.size) ? ` · ${gb(m.size) ?? ""}` : ""}
                                            </option>
                                        ))}
                                        <option value="__custom">Something else (type it)…</option>
                                    </select>
                                    <p className="px-1 text-xs text-muted-foreground">
                                        Live from the server — pulled models only.
                                    </p>
                                </>
                            ) : (
                                <>
                                    <BigInput
                                        icon={Sparkles}
                                        type="text"
                                        value={state.model}
                                        onChange={onModel}
                                        placeholder="Model (required) — e.g. llama3.2"
                                        disabled={pending}
                                    />
                                    {ollamaProbe.error ? (
                                        <p className="px-1 text-xs text-muted-foreground">
                                            Couldn't list the server's models — type the tag to pull.
                                        </p>
                                    ) : listed.length > 0 ? (
                                        <button
                                            type="button"
                                            onClick={() => { setCustomOllama(false); onModel(""); }}
                                            className="self-start px-1 text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                                        >
                                            Back to the server's list
                                        </button>
                                    ) : null}
                                </>
                            )}
                        </div>
                    </Section>
                )}

                {showModelPills && (
                    <Section
                        tile="linear-gradient(180deg, rgba(14,165,233,0.20), rgba(14,165,233,0.10))"
                        tileClass="text-sky-600 ring-sky-500/15 dark:text-sky-400"
                        icon={<Icon icon={Cpu}/>}
                        title="Model"
                        summary={modelLabel}
                        open={showModelOpen}
                        onToggle={() => { setModelOpen(!showModelOpen); }}
                    >
                        <div className="flex flex-col gap-2">
                            <ModelOption
                                model={RUNTIME_DEFAULT}
                                selected={state.model === ""}
                                disabled={pending}
                                onClick={() => { onModel(""); }}
                            />
                            {curated.map((m) => (
                                <ModelOption
                                    key={m.id}
                                    model={m}
                                    selected={state.model === m.id}
                                    disabled={pending}
                                    onClick={() => { onModel(m.id); }}
                                />
                            ))}
                        </div>
                    </Section>
                )}

                {envSupported && (
                    <Section
                        tile="linear-gradient(180deg, rgba(16,185,129,0.20), rgba(16,185,129,0.10))"
                        tileClass="text-emerald-600 ring-emerald-500/15 dark:text-emerald-400"
                        icon={<Icon icon={SourceCode}/>}
                        title="Environment variables"
                        summary={
                            envInvalid ? (
                                <span className="text-destructive">Fix variable names</span>
                            ) : state.envRows.length > 0 ? (
                                `${String(state.envRows.length)} variable${state.envRows.length === 1 ? "" : "s"}`
                            ) : (
                                "None"
                            )
                        }
                        open={showEnvOpen}
                        onToggle={() => { setEnvOpen(!showEnvOpen); }}
                    >
                        <div className="flex flex-col gap-2.5">
                            {state.envRows.map((row, i) => (
                                <EnvVarRow
                                    key={i}
                                    row={row}
                                    disabled={pending}
                                    onChange={(next) => {
                                        onEnvRows(state.envRows.map((r, j) => (j === i ? next : r)));
                                    }}
                                    onRemove={() => {
                                        onEnvRows(state.envRows.filter((_, j) => j !== i));
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
                                onClick={() => { onEnvRows([...state.envRows, {key: "", value: ""}]); }}
                            />
                        </div>
                    </Section>
                )}
            </div>

            {nothingToConfigure && (
                <div className="flex flex-col items-center gap-2 rounded-2xl border border-border/50 bg-foreground/[0.02] px-4 py-8 text-center">
                    <Icon icon={SkipGlyph} className="size-7 text-muted-foreground"/>
                    <p className="text-sm text-muted-foreground">Nothing extra to configure — you're set.</p>
                </div>
            )}

            <Button
                onClick={onCreate}
                disabled={!createEnabled || envInvalid || pending}
                className="mt-4 h-12 w-full text-base"
            >
                {pending ? "Creating…" : "Create agent"}
            </Button>
        </div>
    );
}

/** One flat, collapsible section — no card around it (the step's hairline
 *  dividers carry the structure). The whole header row toggles: a small
 *  app-icon tile + name, then — while closed — the section's current value,
 *  so collapsing never hides a decision. Content keeps its state when closed
 *  (it stays mounted, inert) and the grid-rows trick animates both ways. */
function Section({
    tile,
    tileClass,
    icon,
    title,
    chip,
    summary,
    open,
    onToggle,
    children,
}: {
    tile: string;
    /** Overrides the tile's white-on-gradient default — e.g. the tinted-glass
     *  look (translucent single-hue bg + a fully saturated same-hue icon). */
    tileClass?: string;
    icon: React.ReactNode;
    title: string;
    /** Status chip worth surfacing even while open (e.g. Required). */
    chip?: React.ReactNode;
    /** The section's current value, shown only while closed. */
    summary?: React.ReactNode;
    open: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}) {
    return (
        <section className="py-2.5">
            <button
                type="button"
                aria-expanded={open}
                onClick={onToggle}
                className="group flex min-h-11 w-full items-center gap-3 rounded-lg px-1 py-2 text-left transition-colors hover:bg-foreground/[0.03]"
            >
                <span
                    className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-lg text-white ring-1 ring-white/10 [&_svg]:size-4 [&_img]:size-[18px]",
                        tileClass,
                    )}
                    style={{background: tile}}
                >
                    {icon}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
                {!open && summary != null && (
                    <span className="min-w-0 max-w-[50%] truncate text-[13px] text-muted-foreground">
                        {summary}
                    </span>
                )}
                {chip}
                <Icon
                    icon={ArrowDown}
                    className={cn(
                        "size-4 shrink-0 text-muted-foreground/70 transition-transform duration-200 group-hover:text-foreground",
                        open && "rotate-180",
                    )}
                />
            </button>
            <div
                inert={!open}
                className={cn(
                    "grid transition-[grid-template-rows] duration-300 ease-in-out motion-reduce:transition-none",
                    open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                )}
            >
                <div className="min-h-0 overflow-hidden">
                    <div className="px-1 pt-2.5 pb-3">{children}</div>
                </div>
            </div>
        </section>
    );
}

function Chip({children, tone}: {children: React.ReactNode; tone?: "required"}) {
    return (
        <span
            className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold",
                tone === "required"
                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    : "bg-muted text-muted-foreground",
            )}
        >
            {children}
        </span>
    );
}

/** One selectable model row: a big name + a tier chip, over icon meters
 *  (brain = intelligence, bolt = speed, coins = cost) so the trade-off — smarter
 *  & heavier vs cheaper & faster — reads at a glance without wordy labels. The
 *  one-line descriptor rides along as the hover title. Selection = ring + tinted
 *  bg + a corner check, matching the wizard's OptionCard language. */
function ModelOption({
    model,
    selected,
    disabled,
    onClick,
}: {
    model: CuratedModel;
    selected: boolean;
    disabled: boolean;
    onClick: () => void;
}) {
    const tier = model.tier ? TIER_META[model.tier] : null;
    const hasMeters =
        model.intelligence != null || model.speed != null || model.cost != null;
    return (
        <button
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={onClick}
            title={model.blurb}
            className={cn(
                "relative flex w-full flex-col gap-2.5 rounded-xl border px-3.5 py-3 text-left transition duration-150 active:scale-[0.99] disabled:opacity-50",
                selected
                    ? "border-foreground/40 bg-foreground/[0.06] ring-1 ring-inset ring-foreground/15"
                    : "border-border/50 bg-foreground/[0.02] hover:border-foreground/25 hover:bg-foreground/[0.04]",
            )}
        >
            {selected && (
                <span className="absolute top-3 right-3 flex size-5 items-center justify-center rounded-full bg-foreground text-background">
                    <Icon icon={Tick} className="size-3"/>
                </span>
            )}
            <div className="flex items-center gap-2.5 pr-8">
                <span className="text-[15px] font-semibold leading-none">{model.label}</span>
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
            </div>
            {hasMeters && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <StatMeter icon={Brain} label="Intelligence" level={model.intelligence ?? 0}/>
                    <StatMeter icon={Flash} label="Speed" level={model.speed ?? 0}/>
                    <StatMeter icon={Coins} label="Cost" level={model.cost ?? 0} cost/>
                </div>
            )}
        </button>
    );
}

/** An icon + a 3-segment meter — the relative 1-3 guide, label-free (the icon
 *  IS the label; the full word rides in title/aria for a11y). Cost fills amber,
 *  the one functional colour accent. */
function StatMeter({
    icon,
    label,
    level,
    cost,
}: {
    icon: React.ComponentProps<typeof Icon>["icon"];
    label: string;
    level: number;
    cost?: boolean;
}) {
    return (
        <span
            className="flex items-center gap-1.5"
            title={label}
            aria-label={`${label}: ${String(level)} of 3`}
        >
            <Icon icon={icon} className="size-4 text-muted-foreground"/>
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
    );
}

function BigInput({
    icon,
    value,
    onChange,
    ...props
}: {
    icon: React.ComponentProps<typeof Icon>["icon"];
    value: string;
    onChange: (v: string) => void;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange">) {
    return (
        <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted-foreground">
                <Icon icon={icon} className="size-[18px]"/>
            </span>
            <Input
                className="h-12 rounded-xl pl-11 text-base"
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => { onChange(e.target.value); }}
                {...props}
            />
        </div>
    );
}
