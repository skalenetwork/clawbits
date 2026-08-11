/**
 * "New Agent VM" - a step-by-step wizard (docs/protocol/REEF_CREATE_WIZARD_PLAN.md):
 *
 *   type -> model -> options -> connect -> launch
 *
 * The SummaryRail doubles as the stepper (chips of past choices, click to
 * revisit). This shell owns the providers/images queries, the create mutation,
 * and the booting VM's detail poll; steps stay presentational. The finale shows
 * the one-time access password, then the VM booting live. Reef is always this
 * reef - no deploy/self-host branch, no reef-connection banner (auth is handled
 * globally by the App's AuthDialog).
 */
import { useEffect, useMemo, useState } from "react"
import { ApiError, type CreateSandboxIn } from "@/lib/api"
import { useCreateSandbox, useImages, useProviders, useSandboxDetail } from "@/lib/queries"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { terminalAuthUrl } from "@/lib/utils"
import { AnimatedHeight } from "./AnimatedHeight"
import { SummaryRail } from "./SummaryRail"
import { TypeStep } from "./TypeStep"
import { ConnectStep } from "./ConnectStep"
import { ModelStep } from "./ModelStep"
import { OptionsStep } from "./OptionsStep"
import { LaunchStep } from "./LaunchStep"
import { useCreateWizard, type StepId } from "./useCreateWizard"

const errMsg = (e: unknown): string =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Couldn't create the agent"

/** ChatGPT-subscription (oauth) login the owner runs in the agent's web terminal.
 *  Device-code in both cases, so no browser is needed inside the VM. Only the runtimes
 *  that actually offer the provider appear here (see reef/providers.py). */
const CODEX_LOGIN_COMMAND: Record<string, string> = {
  openclaw: "openclaw models auth login --provider openai --device-code",
  hermes: "hermes login --provider openai-codex --no-browser",
}

export function CreateAgentDialog({
  open,
  onClose,
  onOpenAgent,
}: {
  open: boolean
  onClose: () => void
  onOpenAgent: (id: string) => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-3rem)] gap-0 overflow-y-auto p-0 sm:max-w-2xl"
      >
        {/* Mount the body fresh each open so wizard + mutation state reset. */}
        {open ? <WizardBody onClose={onClose} onOpenAgent={onOpenAgent} /> : <WizardHeader />}
      </DialogContent>
    </Dialog>
  )
}

function WizardHeader() {
  return (
    <div className="flex shrink-0 items-center justify-center px-3 pt-4">
      <DialogTitle className="text-sm font-semibold tracking-tight">New Agent VM</DialogTitle>
    </div>
  )
}

function WizardBody({
  onClose,
  onOpenAgent,
}: {
  onClose: () => void
  onOpenAgent: (id: string) => void
}) {
  const [state, dispatch] = useCreateWizard()

  const providersQuery = useProviders(true)
  const providerList = providersQuery.data?.providers ?? null
  // Create-API feature negotiation: an older self-hosted reef silently drops
  // unknown create fields, so hide the control rather than lie about it.
  const supportsCapabilities = (providersQuery.data?.features ?? []).includes("capabilities")
  const imagesQuery = useImages(false)
  const images = imagesQuery.data ?? null

  const create = useCreateSandbox()
  const created = create.data ?? null
  const createdSandboxId = created?.sandbox_id ?? null

  // Poll the booting VM once created so the card flips creating -> running.
  const detailQuery = useSandboxDetail(createdSandboxId, createdSandboxId ? 2000 : false)
  const liveState = detailQuery.data?.state ?? created?.state ?? "creating"
  const liveColor = detailQuery.data?.color ?? null

  const [pwCopied, setPwCopied] = useState(false)
  const copyPassword = () => {
    const pw = created?.access?.password
    if (pw) {
      void navigator.clipboard?.writeText(pw)
      setPwCopied(true)
    }
  }

  // ── Provider invalidation: the pick must survive list refetches and runtime
  //    changes only while it stays valid. ──
  useEffect(() => {
    if (state.providerId === null || state.providerId === "none" || providerList === null) return
    const p = providerList.find((x) => x.id === state.providerId)
    const unsupported =
      p?.runtimes && state.runtime !== null && !p.runtimes.includes(state.runtime)
    const lostKey =
      p && !p.configured && !(state.byoValues[p.id] ?? "").trim() && state.step === "launch"
    if (!p || unsupported || lostKey) dispatch({ type: "invalidate-provider" })
  }, [providerList, state.runtime, state.providerId, state.byoValues, state.step, dispatch])

  // ── Validity ──
  const picked = providerList?.find((p) => p.id === state.providerId) ?? null
  const pickedEndpoint = (picked?.kind ?? "api_key") === "endpoint"
  const byoValue = picked ? (state.byoValues[picked.id] ?? "").trim() : ""
  const pickNeedsValue = Boolean(picked && !picked.configured && byoValue.length === 0)
  const byoBadUrl = Boolean(
    picked && pickedEndpoint && byoValue.length > 0 && !/^https?:\/\//i.test(byoValue),
  )
  const pickNeedsModel = Boolean(picked && pickedEndpoint && state.model.trim().length === 0)
  const modelStepComplete =
    state.providerId !== null && !pickNeedsValue && !byoBadUrl && !pickNeedsModel
  const createEnabled = providerList !== null && state.runtime !== null && modelStepComplete

  // ── ChatGPT-subscription (oauth) handoff for the Launch step ──
  // Only when an oauth provider was picked AND the create returned an exposed
  // terminal + the one-time password (both live only in the create response).
  const codexConnect = useMemo(() => {
    if (picked?.kind !== "oauth") return null
    const terminalUrl = created?.access?.terminal_url
    const pw = created?.access?.password
    if (!terminalUrl || !pw) return null
    return {
      terminalOpenUrl: terminalAuthUrl(terminalUrl, pw),
      // Runtime-specific: each engine has its own device-code login, and handing a
      // Hermes owner an `openclaw …` command is a dead end.
      command: CODEX_LOGIN_COMMAND[state.runtime ?? "openclaw"] ?? CODEX_LOGIN_COMMAND.openclaw,
    }
  }, [picked?.kind, created?.access?.terminal_url, created?.access?.password, state.runtime])

  const createError = create.isError ? errMsg(create.error) : null
  // Launch locks the rail (the frozen chips are the record of what was chosen);
  // a failed create unfreezes it for Retry / Back.
  const frozen = state.launched && createError === null

  const buildBody = (): CreateSandboxIn => {
    const body: CreateSandboxIn = { type: state.runtime ?? "openclaw" }
    if (state.imageTag) body.image = state.imageTag
    if (state.connect === true && state.orgId.trim()) {
      body.org_id = state.orgId.trim()
      if (state.clawbitsUrl.trim()) body.clawbits_url = state.clawbitsUrl.trim()
      if (state.signupToken.trim()) body.signup_token = state.signupToken.trim()
    }
    if (state.providerId) {
      body.provider = state.providerId
      // Send a per-request key/host whenever the operator typed one - it wins
      // over the reef-level value server-side, so this works as an override even
      // when the provider is already configured on the Reef.
      if (picked && picked.id !== "none") {
        const own = (state.byoValues[picked.id] ?? "").trim()
        if (own && picked.id === "openai") body.openai_api_key = own
        if (own && picked.id === "anthropic") body.anthropic_api_key = own
        if (own && picked.id === "gemini") body.gemini_api_key = own
        if (own && picked.id === "nearai") body.nearai_api_key = own
        if (own && picked.id === "ollama") body.ollama_host = own
      }
      if (state.model.trim()) body.model = state.model.trim()
    }
    const env = state.envRows
      .map((r) => [r.key.trim(), r.value] as const)
      .filter(([k]) => k.length > 0)
    if (env.length > 0) body.env = Object.fromEntries(env)
    // Only send when this reef advertises the field: an older reef's Pydantic
    // would silently DROP it, producing an agent whose real capabilities differ
    // from what this wizard just showed. `features` comes from GET /providers.
    if (state.capabilities.length > 0 && supportsCapabilities) {
      body.capabilities = state.capabilities
    }
    return body
  }

  const submit = () => {
    dispatch({ type: "launch" })
    create.mutate(buildBody())
  }

  const goto = (step: StepId) => {
    dispatch({ type: "goto", step })
  }

  const openDetail = () => {
    if (createdSandboxId) onOpenAgent(createdSandboxId)
    onClose()
  }

  return (
    <>
      <WizardHeader />
      <div className="flex flex-col gap-3 p-3">
        <SummaryRail state={state} frozen={frozen} providers={providerList} onGoto={goto} />

        <AnimatedHeight>
          <div
            key={state.step}
            className="flex flex-col animate-in fade-in slide-in-from-right-2 duration-300"
          >
            {state.step === "type" && (
              <TypeStep
                runtime={state.runtime}
                onPick={(name) => {
                  dispatch({ type: "pick-runtime", runtime: name })
                }}
                images={images}
                imageTag={state.imageTag}
                onImageTag={(tag) => {
                  dispatch({ type: "set-image", tag })
                }}
              />
            )}
            {state.step === "model" && (
              <ModelStep
                runtime={state.runtime}
                providerId={state.providerId}
                providers={providerList}
                providersLoading={providersQuery.isLoading}
                providersError={providersQuery.isError}
                onPick={(id) => {
                  dispatch({ type: "pick-provider", id })
                  dispatch({ type: "goto", step: "options" })
                }}
              />
            )}
            {state.step === "options" && (
              <OptionsStep
                state={state}
                providers={providerList}
                onByo={(id, value) => {
                  dispatch({ type: "set-byo", id, value })
                }}
                onModel={(model) => {
                  dispatch({ type: "set-model", model })
                }}
                onEnvRows={(rows) => {
                  dispatch({ type: "set-env", rows })
                }}
                supportsCapabilities={supportsCapabilities}
                onToggleCapability={(id) => {
                  dispatch({ type: "toggle-capability", id })
                }}
                onContinue={() => {
                  dispatch({ type: "goto", step: "connect" })
                }}
                continueEnabled={createEnabled}
                pending={create.isPending}
              />
            )}
            {state.step === "connect" && (
              <ConnectStep
                connect={state.connect}
                orgId={state.orgId}
                signupToken={state.signupToken}
                clawbitsUrl={state.clawbitsUrl}
                pending={create.isPending}
                onPick={(connect) => {
                  dispatch({ type: "pick-connect", connect })
                  // Standalone is the last pick on this (last) step - fire the
                  // create at once, same as the details screen's Continue below.
                  if (!connect) submit()
                }}
                onField={(field, value) => {
                  dispatch({ type: "set-clawbits", field, value })
                }}
                onBack={() => {
                  dispatch({ type: "back-to-connect" })
                }}
                onContinue={submit}
              />
            )}
            {state.step === "launch" && (
              <LaunchStep
                createError={createError}
                onRetry={() => {
                  create.mutate(buildBody())
                }}
                onBack={() => {
                  create.reset()
                  dispatch({ type: "unlaunch" })
                  dispatch({ type: "goto", step: "options" })
                }}
                password={created?.access?.password ?? null}
                // Idle counts as pending: onBack/onRetry reset the mutation, and a
                // settled-with-no-password verdict only means anything once it ran.
                passwordPending={!create.isSuccess && !create.isError}
                pwCopied={pwCopied}
                onCopyPassword={copyPassword}
                sandboxId={createdSandboxId}
                agentType={created?.agent_type ?? state.runtime ?? "openclaw"}
                state={liveState}
                color={liveColor}
                access={created?.access ?? null}
                onOpenDetail={openDetail}
                codex={codexConnect}
              />
            )}
          </div>
        </AnimatedHeight>
      </div>
    </>
  )
}
