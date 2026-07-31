/**
 * Step 5 - Launch: the wizard's finale. Two beats. First the one-time access
 * password (reef mints it at create and can never recompute it), then the
 * BootingCard - the freshly-created VM booting live, with the three things an
 * operator wants next. A failed create takes over with Retry / Back.
 */
import { useState } from "react"
import {
  Alert02Icon,
  ArrowLeft01Icon,
  Copy01Icon,
  Tick01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons"
import type { AccessInfo, SandboxState } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/Icon"
import { cn } from "@/lib/utils"
import { AccessPasswordScreen, BootingCard } from "./bits"
import chatgptUi from "@/assets/chatgpt-ui.webp"

export function LaunchStep({
  createError,
  onRetry,
  onBack,
  password,
  passwordPending,
  pwCopied,
  onCopyPassword,
  sandboxId,
  agentType,
  state,
  color,
  access,
  onOpenDetail,
  codex,
}: {
  createError: string | null
  onRetry: () => void
  onBack: () => void
  password: string | null
  /** The create call is still in flight, so a password may yet land. On the
   *  wire "no password" and "not yet" are both null - this tells them apart.
   *  (All current runtimes mint one; Hermes' is the dashboard proxy's
   *  basic-auth secret, revealed only on this create response - see
   *  ``HermesProfile.exposure_password``.) */
  passwordPending: boolean
  pwCopied: boolean
  onCopyPassword: () => void
  sandboxId: string | null
  agentType: string
  state: SandboxState
  color: string | null
  access: AccessInfo | null
  onOpenDetail: () => void
  /** ChatGPT-subscription agents: the one-command, in-terminal device-code
   *  login handoff (auto-authed terminal URL + the command). null otherwise. */
  codex: { terminalOpenUrl: string; command: string } | null
}) {
  // The password gets its own beat BEFORE the card: we show this screen the instant
  // we launch and the password streams in a moment later. An errored create hands
  // off to the error block below.
  //
  // Gate on `passwordPending || password`, never on `password` alone: should a
  // create ever settle with no password there is nothing left to wait for, and
  // waiting anyway strands the wizard on a spinner with its Continue button
  // disabled.
  const [pwSaved, setPwSaved] = useState(false)
  const [connectSeen, setConnectSeen] = useState(false)
  const showPasswordGate =
    createError === null && !pwSaved && (passwordPending || password !== null)
  // ChatGPT-subscription agents get the connect handoff on its OWN screen,
  // right after the password gate - the OAuth login is the real "make it
  // work" step, so it isn't crammed under the booting card.
  const showConnectScreen = !showPasswordGate && codex !== null && createError === null && !connectSeen

  if (createError !== null) {
    return (
      <div className="flex w-full animate-in flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3.5 fade-in duration-300">
        <p className="flex items-start gap-2 text-[13px] font-medium text-destructive">
          <Icon icon={Alert02Icon} className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{createError}</span>
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
          <Button size="sm" variant="ghost" onClick={onBack} className="gap-1">
            <Icon icon={ArrowLeft01Icon} className="size-3.5" />
            Back
          </Button>
        </div>
      </div>
    )
  }

  if (showPasswordGate) {
    return (
      <AccessPasswordScreen
        password={password}
        agentType={agentType}
        copied={pwCopied}
        onCopy={onCopyPassword}
        onContinue={() => {
          setPwSaved(true)
        }}
      />
    )
  }

  if (showConnectScreen) {
    // `codex` is narrowed non-null here - showConnectScreen's definition
    // includes `codex !== null`.
    return (
      <CodexConnectScreen
        command={codex.command}
        terminalOpenUrl={codex.terminalOpenUrl}
        ready={state === "running"}
        onContinue={() => {
          setConnectSeen(true)
        }}
      />
    )
  }

  return (
    <BootingCard
      sandboxId={sandboxId ?? ""}
      agentType={agentType}
      state={state}
      color={color}
      access={access}
      password={password}
      onOpenDetail={onOpenDetail}
    />
  )
}

/** ChatGPT-subscription (Codex OAuth) handoff - its own focused screen,
 *  mirroring the access-password beat. Open the agent's own web terminal
 *  (pre-authed), run the device-code login, approve in the browser. The
 *  login happens inside the agent's VM - the OAuth token never touches
 *  Clawbits/Reef. */
function CodexConnectScreen({
  command,
  terminalOpenUrl,
  ready,
  onContinue,
}: {
  command: string
  terminalOpenUrl: string
  /** VM is running - its ttyd (web terminal) starts BEFORE the gateway, so
   *  "running" guarantees the terminal is serving. Gate "Open terminal" on it
   *  to avoid a 502 from opening the surface while the VM is still booting. */
  ready: boolean
  onContinue: () => void
}) {
  const [cmdCopied, setCmdCopied] = useState(false)
  const copyCmd = () => {
    void navigator.clipboard.writeText(command)
    setCmdCopied(true)
    window.setTimeout(() => {
      setCmdCopied(false)
    }, 1500)
  }
  return (
    <div className="flex w-full animate-in flex-col gap-4 py-1 fade-in duration-300">
      <div className="flex flex-col gap-4 px-3">
        <div className="flex flex-col gap-1 text-center">
          <h3 className="text-xl font-semibold tracking-tight">Connect your ChatGPT plan</h3>
          <p className="text-[13px] text-muted-foreground">
            Run this in your agent's terminal, then approve in your browser.
          </p>
        </div>

        {/* The agent's own web terminal this unlocks, shown clean - same
            treatment as the access-password step's Control UI preview. */}
        <div className="w-full overflow-hidden rounded-2xl border border-border/50 bg-muted">
          <img
            src={chatgptUi}
            alt=""
            draggable={false}
            className="aspect-[20/9] w-full select-none object-cover"
          />
        </div>

        <div className="flex min-h-[68px] w-full items-center gap-2 rounded-2xl border border-border/70 bg-foreground/[0.03] px-5">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[15px] font-medium select-all">
            {command}
          </code>
          <button
            type="button"
            onClick={copyCmd}
            aria-label="Copy command"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <Icon
              icon={cmdCopied ? Tick01Icon : Copy01Icon}
              className={cn("size-5", cmdCopied && "text-emerald-500")}
            />
          </button>
        </div>
      </div>

      <Button
        onClick={() => {
          window.open(terminalOpenUrl, "_blank", "noopener,noreferrer")
        }}
        disabled={!ready}
        className="h-12 w-full gap-2 bg-emerald-600 text-white hover:bg-emerald-600/90 disabled:opacity-60"
      >
        {ready ? (
          <>
            <Icon icon={TerminalIcon} className="size-4" />
            Open terminal
          </>
        ) : (
          <>
            <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Waiting for your agent…
          </>
        )}
      </Button>
      <Button onClick={onContinue} className="h-12 w-full text-base">
        Continue
      </Button>
    </div>
  )
}
