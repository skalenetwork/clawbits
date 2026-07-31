/** Shared presentational primitives for the create-agent wizard. */
import {
  ArrowRight01Icon,
  Cancel01Icon,
  Copy01Icon,
  Globe02Icon,
  PlusSignIcon,
  TerminalIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons"
import type { AccessInfo, SandboxState } from "@/lib/api"
import { agentMeta } from "@/lib/agentTypes"
import { AgentAvatar } from "@/components/AgentAvatar"
import { Icon } from "@/components/Icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { surfaceAuthUrl, terminalAuthUrl } from "@/lib/utils"
import openclawUi from "@/assets/openclaw-ui.webp"

/** POSIX env-var name; mirrors reef's server-side rule (reserved keys etc. come
 *  back as a readable 422 toast). */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** One of the wizard's big option cards: icon-led, one-line description max,
 *  selection = ring + corner check. The WHOLE card is the click target. `tile`
 *  puts the icon on its own tinted app-icon tile (the per-card accent that keeps
 *  sibling cards visually distinct); plain `icon` renders bare. */
export function OptionCard({
  icon,
  tile,
  title,
  line,
  trailing,
  selected,
  disabled,
  onSelect,
  children,
  className,
}: {
  icon: React.ReactNode
  /** CSS background for the icon tile; omit for a bare icon. */
  tile?: string
  title: string
  line?: React.ReactNode
  /** Corner slot (e.g. a Ready pill). The selection check replaces it. */
  trailing?: React.ReactNode
  selected: boolean
  disabled?: boolean
  onSelect: () => void
  /** Extra content revealed inside the card (e.g. the image select). */
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "relative flex flex-col gap-3 rounded-2xl border p-4 text-left transition duration-200",
        selected
          ? "border-foreground/40 bg-foreground/[0.05]"
          : "border-border/50 bg-foreground/[0.02]",
        !disabled && !selected && "hover:border-foreground/25 hover:bg-foreground/[0.04]",
        // Slight press-in - the whole card scales because :active propagates
        // from the stretched button to this ancestor.
        !disabled && "active:scale-[0.98]",
        disabled && "opacity-50",
        className,
      )}
    >
      <button
        type="button"
        disabled={disabled}
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "flex w-full flex-col items-start gap-3 text-left disabled:cursor-not-allowed",
          // Stretched hit target: the ::after covers the WHOLE card so a click
          // anywhere (incl. the padding near the border) selects. Skipped when
          // disabled so an embedded control stays clickable.
          !disabled && "after:absolute after:inset-0 after:content-['']",
        )}
      >
        {tile ? (
          <span
            className="flex size-13 items-center justify-center rounded-2xl text-white ring-1 ring-white/10 [&_svg]:size-7 [&_img]:size-8"
            style={{ background: tile }}
          >
            {icon}
          </span>
        ) : (
          <span className="flex size-13 items-center justify-center text-foreground/90 [&_svg]:size-11 [&_img]:size-11">
            {icon}
          </span>
        )}
        <span className="text-lg font-semibold leading-none">{title}</span>
        {line != null && (
          <span className="text-[13px] leading-snug text-muted-foreground">{line}</span>
        )}
      </button>
      {/* Corner slot - visual only, so it never blocks the stretched target. */}
      <span className="pointer-events-none absolute top-3 right-3">
        {selected ? (
          <span className="flex size-5 animate-in items-center justify-center rounded-full bg-foreground text-background zoom-in-50 duration-150">
            <Icon icon={Tick01Icon} className="size-3" />
          </span>
        ) : (
          trailing
        )}
      </span>
      {/* Revealed extras (image select, clawbits fields) sit ABOVE the stretched
          target so they stay independently interactive. */}
      {children && <div className="relative z-10">{children}</div>}
    </div>
  )
}

/** An input with a leading glyph - the wizard's one field primitive. */
export function IconField({
  icon,
  ...props
}: { icon: React.ComponentProps<typeof Icon>["icon"] } & React.ComponentProps<typeof Input>) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground">
        <Icon icon={icon} className="size-[18px]" />
      </span>
      <Input className="h-12 pl-11 text-base" autoComplete="off" {...props} />
    </div>
  )
}

/** One editable NAME=value row of the custom-env editor. */
export function EnvVarRow({
  row,
  disabled,
  onChange,
  onRemove,
}: {
  row: { key: string; value: string }
  disabled: boolean
  onChange: (next: { key: string; value: string }) => void
  onRemove: () => void
}) {
  const k = row.key.trim()
  const invalid = k.length > 0 && !ENV_KEY_RE.test(k)
  return (
    <div className="flex items-center gap-2">
      <Input
        value={row.key}
        onChange={(e) => {
          onChange({ ...row, key: e.target.value })
        }}
        placeholder="NAME"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        aria-invalid={invalid}
        className={cn("flex-1 font-mono text-[13px]", invalid && "border-destructive/60")}
      />
      <Input
        value={row.value}
        onChange={(e) => {
          onChange({ ...row, value: e.target.value })
        }}
        placeholder="value"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="flex-[1.4] font-mono text-[13px]"
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Remove variable"
        className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <Icon icon={Cancel01Icon} className="size-4" />
      </button>
    </div>
  )
}

export function AddEnvRowButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-1.5 self-start py-0.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
    >
      <Icon icon={PlusSignIcon} className="size-3.5" />
      Add variable
    </button>
  )
}

/** One-time access-password reveal - its own focused beat before the booting
 *  card. Reef mints the secret at creation and can never recompute it, so the
 *  finale waits here until the operator has taken it. Deliberately visual and
 *  terse: a key tile, the secret (tap to copy), one action. */
export function AccessPasswordScreen({
  password,
  copied,
  onCopy,
  onContinue,
  agentType,
}: {
  /** null while the Reef is still minting it - the screen shows a spinner. */
  password: string | null
  copied: boolean
  onCopy: () => void
  onContinue: () => void
  /** Branches the copy/preview: Hermes unlocks a basic-auth dashboard (user
   *  `reef`), not the OpenClaw Control UI shown in the screenshot. */
  agentType?: string
}) {
  const isHermes = agentType === "hermes"
  return (
    <div className="flex w-full animate-in flex-col gap-4 py-1 fade-in duration-300">
      <div className="flex flex-col gap-1 text-center">
        <h3 className="text-xl font-semibold tracking-tight">Save your access password</h3>
        <p className="text-[13px] text-muted-foreground">
          {isHermes ? (
            <>
              Unlocks the dashboard &amp; terminal — both sign in with username{" "}
              <code className="font-mono text-foreground">reef</code>.
            </>
          ) : (
            <>Unlocks the Control UI &amp; terminal.</>
          )}
        </p>
      </div>

      {/* The Control UI this unlocks, shown clean. (There's no Hermes
          screenshot asset — its gate skips the preview.) */}
      {!isHermes && (
        <div className="w-full overflow-hidden rounded-2xl border border-border/50 bg-muted">
          <img
            src={openclawUi}
            alt=""
            draggable={false}
            className="aspect-[20/9] w-full select-none object-cover"
          />
        </div>
      )}

      {/* The one-time secret. ONE fixed-height box holds both states, so the
          placeholder and the final password are exactly the same size - the
          card never jumps when it lands. */}
      <div className="flex min-h-[68px] w-full items-center justify-center rounded-2xl border border-border/70 bg-foreground/[0.03] px-6 text-center">
        {password ? (
          <code className="break-all font-mono text-xl font-semibold tracking-wide select-all">
            {password}
          </code>
        ) : (
          <span className="flex items-center gap-2.5 text-xl font-medium text-muted-foreground">
            <span className="size-5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
            Generating your password…
          </span>
        )}
      </div>

      <Button
        disabled={!password}
        onClick={() => {
          if (!copied) onCopy()
          onContinue()
        }}
        className="h-12 w-full gap-2 text-base"
      >
        {password ? (
          <>
            <Icon icon={copied ? Tick01Icon : Copy01Icon} className="size-4" />
            {copied ? "Continue" : "Copy & continue"}
          </>
        ) : (
          "Creating your agent…"
        )}
      </Button>
    </div>
  )
}

/** The finale after the password beat: the freshly-created VM, booting live.
 *  Mirrors the clawbits "here's your agent" moment, reef-native - the avatar +
 *  a status badge that flips creating -> running as the shell polls detail, over
 *  the three things an operator wants next. */
export function BootingCard({
  sandboxId,
  agentType,
  state,
  color,
  access,
  password,
  onOpenDetail,
}: {
  sandboxId: string
  agentType: string
  state: SandboxState
  color: string | null
  access: AccessInfo | null
  password: string | null
  onOpenDetail: () => void
}) {
  const running = state === "running"
  const meta = agentMeta(agentType)
  const primaryLabel = agentType === "hermes" ? "Open Dashboard" : "Open Control UI"
  const controlHref = access?.url
    ? surfaceAuthUrl(agentType, access.url, access.password ?? "")
    : undefined
  const terminalHref = access?.terminal_url
    ? terminalAuthUrl(access.terminal_url, access.password ?? "")
    : undefined
  const openExternal = (href: string) => window.open(href, "_blank", "noopener,noreferrer")

  return (
    <div className="flex w-full animate-in flex-col items-center gap-4 fade-in duration-300">
      {/* Identity: big avatar with the name + type alongside it. Running state
          reads from the avatar's live status dot (no separate chip). */}
      <div className="flex w-full items-center gap-4 rounded-2xl border border-border/50 bg-foreground/[0.02] px-5 py-6">
        <AgentAvatar
          entry={{ agent_type: agentType, profile: null, image: "", state, color }}
          size="xl"
          ringClass="ring-popover"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-3xl font-semibold leading-tight break-words">{sandboxId}</span>
          <span className="text-sm text-muted-foreground">{meta.label}</span>
        </div>
      </div>

      {/* The access password stays visible here too - reef mints it once and
          can never recompute it. Plain text (same box as the "save password"
          screen), select to copy. */}
      {password && (
        <div className="w-full">
          <div className="mb-1.5 px-1 text-xs text-muted-foreground">Access password</div>
          <div className="flex min-h-[68px] w-full items-center justify-center rounded-2xl border border-border/70 bg-foreground/[0.03] px-6 text-center">
            <code className="font-mono text-xl font-semibold tracking-wide break-all select-all">
              {password}
            </code>
          </div>
          {agentType === "hermes" && (
            // The dashboard's nginx basic-auth needs a username too.
            <div className="mt-1.5 px-1 text-xs text-muted-foreground">
              Dashboard and terminal sign in with username{" "}
              <code className="font-mono">reef</code> and this password.
            </div>
          )}
        </div>
      )}

      {/* The three actions grouped tight. Primary (enter the agent) is disabled
          with a live "booting" label until the VM is running - same
          waiting-then-live shape as clawbits. */}
      <div className="flex w-full flex-col gap-1.5">
        <Button
          disabled={!running || !controlHref}
          onClick={() => {
            if (controlHref) openExternal(controlHref)
          }}
          className="h-12 w-full gap-2 text-base"
        >
          {running ? (
            <>
              <Icon icon={Globe02Icon} className="size-4" />
              {primaryLabel}
            </>
          ) : (
            <>
              <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Booting your agent…
            </>
          )}
        </Button>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            disabled={!running || !terminalHref}
            onClick={() => {
              if (terminalHref) openExternal(terminalHref)
            }}
            className="h-11 flex-1 gap-2"
          >
            <Icon icon={TerminalIcon} className="size-4" />
            Terminal
          </Button>
          <Button variant="outline" onClick={onOpenDetail} className="h-11 flex-1 gap-2">
            View details
            <Icon icon={ArrowRight01Icon} className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
