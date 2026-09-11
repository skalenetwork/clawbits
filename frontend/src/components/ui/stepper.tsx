import { Minus, Plus } from "lucide-react"

const STEP_BUTTON =
  "flex h-full w-7 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"

function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
  "aria-label": ariaLabel,
}: {
  value: number
  onChange: (next: number) => void
  min: number
  max: number
  step?: number
  disabled?: boolean
  "aria-label"?: string
}) {
  const nudge = (delta: number) => {
    onChange(Math.min(max, Math.max(min, value + delta)))
  }
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-slot="stepper"
      className="inline-flex h-[30px] items-center rounded-lg border border-border bg-background"
    >
      <button
        type="button"
        aria-label="Decrease"
        className={STEP_BUTTON}
        disabled={disabled || value <= min}
        onClick={() => { nudge(-step) }}
      >
        <Minus className="size-3.5" />
      </button>
      <span
        key={value}
        className="min-w-6 text-center text-[13px] font-medium tabular-nums text-foreground animate-in zoom-in-75 fade-in duration-200 motion-reduce:animate-none"
      >
        {value}
      </span>
      <button
        type="button"
        aria-label="Increase"
        className={STEP_BUTTON}
        disabled={disabled || value >= max}
        onClick={() => { nudge(step) }}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}

export { Stepper }
