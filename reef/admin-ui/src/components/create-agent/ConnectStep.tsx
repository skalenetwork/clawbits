/**
 * Step 4 - Clawbits link (optional), a two-screen step:
 *   • the card picker: "Connect to Clawbits" vs "Standalone VM" (no clawbits
 *     identity, fires the create at once)
 *   • picking Connect opens a SEPARATE details screen (org / signup-token / URL)
 * Both runtimes' reef profiles bridge org_id + signup_token into CLAWBITS_* env,
 * so this applies regardless of type. The backend requires clawbits_url when
 * org_id is set - so does Continue. Connect is the LAST configurable step - both
 * the Standalone pick and the details screen's Continue fire the actual create.
 */
import { ArrowLeft01Icon, CubeIcon, IdIcon, Key01Icon, Link01Icon } from "@hugeicons/core-free-icons"
import { ClawbitsIcon } from "@/components/agent-icons"
import { Icon } from "@/components/Icon"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { IconField, OptionCard } from "./bits"

/** The black tile the Clawbits mark rides on (the picker card). */
const CLAWBITS_TILE = "linear-gradient(180deg, black, #313131)"
/** Standalone's tile - a vibrant indigo→violet, distinct from the black
 *  Clawbits tile. */
const STANDALONE_TILE = "linear-gradient(160deg, #6366f1, #8b5cf6)"

/** One-click fills for the Clawbits URL field: prod, staging, and the two local
 *  guest->host aliases (localhost inside the guest is the guest itself). */
export const CLAWBITS_URL_PRESETS = [
  { label: "app.clawbits.ai", url: "https://app.clawbits.ai" },
  { label: "app.freeclaws.ai", url: "https://app.freeclaws.ai" },
  { label: "msb host:8000", url: "http://host.microsandbox.internal:8000" },
  { label: "docker host:8000", url: "http://host.docker.internal:8000" },
] as const

export function ConnectStep({
  connect,
  orgId,
  signupToken,
  clawbitsUrl,
  pending,
  onPick,
  onField,
  onBack,
  onContinue,
}: {
  connect: boolean | null
  orgId: string
  signupToken: string
  clawbitsUrl: string
  pending: boolean
  onPick: (connect: boolean) => void
  onField: (field: "orgId" | "signupToken" | "clawbitsUrl", value: string) => void
  onBack: () => void
  onContinue: () => void
}) {
  // Screen 2: the clawbits details form (reached by picking "Connect").
  if (connect === true) {
    const canContinue = orgId.trim().length > 0 && clawbitsUrl.trim().length > 0
    return (
      <div className="flex w-full animate-in flex-col gap-4 py-1 fade-in duration-300">
        <h3 className="text-center text-xl font-semibold tracking-tight">Connect to Clawbits</h3>

        <div className="flex flex-col gap-2.5">
          <IconField
            icon={IdIcon}
            value={orgId}
            onChange={(e) => {
              onField("orgId", e.target.value)
            }}
            placeholder="Org ID"
            disabled={pending}
          />
          <IconField
            icon={Key01Icon}
            value={signupToken}
            onChange={(e) => {
              onField("signupToken", e.target.value)
            }}
            placeholder="Signup token (human-…)"
            disabled={pending}
          />
          <IconField
            icon={Link01Icon}
            value={clawbitsUrl}
            onChange={(e) => {
              onField("clawbitsUrl", e.target.value)
            }}
            placeholder="API URL (required)"
            disabled={pending}
          />
          <div className="flex flex-wrap gap-1.5">
            {CLAWBITS_URL_PRESETS.map((p) => {
              const active = clawbitsUrl.trim() === p.url
              return (
                <button
                  key={p.url}
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    onField("clawbitsUrl", p.url)
                  }}
                  title={p.url}
                  className={cn(
                    "cursor-pointer rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors disabled:opacity-50",
                    active
                      ? "border-primary bg-accent text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {p.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={onBack}
            disabled={pending}
            className="h-12 gap-1.5"
          >
            <Icon icon={ArrowLeft01Icon} className="size-4" />
            Back
          </Button>
          <Button
            onClick={onContinue}
            disabled={!canContinue || pending}
            className="h-12 flex-1 text-base"
          >
            Continue
          </Button>
        </div>
      </div>
    )
  }

  // Screen 1: the two cards.
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <OptionCard
        icon={<ClawbitsIcon className="size-7" />}
        tile={CLAWBITS_TILE}
        title="Connect to Clawbits"
        line="Enrolls into an org and joins its channels."
        // Picking this navigates to the details screen rather than toggling, so
        // it never shows selected on the picker itself.
        selected={false}
        disabled={pending}
        onSelect={() => {
          onPick(true)
        }}
      />
      <OptionCard
        icon={<Icon icon={CubeIcon} />}
        tile={STANDALONE_TILE}
        title="Standalone VM"
        line="No clawbits identity - just the runtime."
        selected={connect === false}
        disabled={pending}
        onSelect={() => {
          onPick(false)
        }}
      />
    </div>
  )
}
